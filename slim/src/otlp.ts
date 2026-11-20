// OTLP trace export decoding: protobuf or JSON in, the OTLP/JSON object shape
// out (hex ids, nanosecond timestamps as decimal strings, attribute values as
// { stringValue | intValue | ... }), which Langfuse's OtelIngestionProcessor
// accepts as is. Only the fields of opentelemetry/proto/trace/v1 that Langfuse
// reads are kept; unknown fields are skipped.

export type AnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: AnyValue[] };
  kvlistValue?: { values: KeyValue[] };
  bytesValue?: string;
};
export type KeyValue = { key: string; value: AnyValue };
export type Span = {
  traceId: string;
  spanId: string;
  traceState?: string;
  parentSpanId?: string;
  flags?: number;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  events: { timeUnixNano: string; name: string; attributes: KeyValue[] }[];
  links: { traceId: string; spanId: string; attributes: KeyValue[] }[];
  status?: { code?: number; message?: string };
};
export type ResourceSpans = {
  resource?: { attributes: KeyValue[] };
  scopeSpans: { scope?: { name?: string; version?: string; attributes: KeyValue[] }; spans: Span[] }[];
};

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end = buf.length) {}
  done() {
    return this.pos >= this.end;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.end) throw new Error("truncated varint");
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error("varint too long");
    }
  }
  uint32(): number {
    return Number(this.varint() & 0xffffffffn);
  }
  bytes(): Uint8Array {
    const len = this.uint32();
    if (this.pos + len > this.end) throw new Error("truncated bytes");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  sub(): Reader {
    const len = this.uint32();
    if (this.pos + len > this.end) throw new Error("truncated message");
    const r = new Reader(this.buf, this.pos + len);
    r.pos = this.pos;
    this.pos += len;
    return r;
  }
  fixed64(): bigint {
    if (this.pos + 8 > this.end) throw new Error("truncated fixed64");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getBigUint64(0, true);
    this.pos += 8;
    return v;
  }
  fixed32(): number {
    if (this.pos + 4 > this.end) throw new Error("truncated fixed32");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getUint32(0, true);
    this.pos += 4;
    return v;
  }
  double(): number {
    if (this.pos + 8 > this.end) throw new Error("truncated double");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }
  skip(wireType: number) {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) this.pos += this.uint32();
    else if (wireType === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wireType}`);
  }
  /** Iterates fields: calls fn(fieldNumber, wireType); fn must consume the value or return false to skip it. */
  fields(fn: (field: number, wireType: number) => boolean | void) {
    while (!this.done()) {
      const tag = this.uint32();
      const field = tag >>> 3;
      const wireType = tag & 7;
      if (fn(field, wireType) === false) this.skip(wireType);
    }
  }
}

const utf8 = new TextDecoder();
const str = (r: Reader) => utf8.decode(r.bytes());
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const base64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const int64 = (v: bigint) => BigInt.asIntN(64, v).toString();

function anyValue(r: Reader): AnyValue {
  const out: AnyValue = {};
  r.fields((f, w) => {
    if (f === 1 && w === 2) out.stringValue = str(r);
    else if (f === 2 && w === 0) out.boolValue = r.varint() !== 0n;
    else if (f === 3 && w === 0) out.intValue = int64(r.varint());
    else if (f === 4 && w === 1) out.doubleValue = r.double();
    else if (f === 5 && w === 2) {
      const s = r.sub();
      const values: AnyValue[] = [];
      s.fields((f2, w2) => (f2 === 1 && w2 === 2 ? void values.push(anyValue(s.sub())) : false));
      out.arrayValue = { values };
    } else if (f === 6 && w === 2) {
      const s = r.sub();
      const values: KeyValue[] = [];
      s.fields((f2, w2) => (f2 === 1 && w2 === 2 ? void values.push(keyValue(s.sub())) : false));
      out.kvlistValue = { values };
    } else if (f === 7 && w === 2) out.bytesValue = base64(r.bytes());
    else return false;
  });
  return out;
}

function keyValue(r: Reader): KeyValue {
  const kv: KeyValue = { key: "", value: {} };
  r.fields((f, w) => {
    if (f === 1 && w === 2) kv.key = str(r);
    else if (f === 2 && w === 2) kv.value = anyValue(r.sub());
    else return false;
  });
  return kv;
}

function attributesOf(r: Reader, into: KeyValue[]) {
  into.push(keyValue(r.sub()));
}

function span(r: Reader): Span {
  const s: Span = {
    traceId: "",
    spanId: "",
    name: "",
    startTimeUnixNano: "0",
    endTimeUnixNano: "0",
    attributes: [],
    events: [],
    links: [],
  };
  r.fields((f, w) => {
    if (f === 1 && w === 2) s.traceId = hex(r.bytes());
    else if (f === 2 && w === 2) s.spanId = hex(r.bytes());
    else if (f === 3 && w === 2) s.traceState = str(r);
    else if (f === 4 && w === 2) {
      const id = hex(r.bytes());
      if (id) s.parentSpanId = id;
    } else if (f === 16 && w === 5) s.flags = r.fixed32();
    else if (f === 5 && w === 2) s.name = str(r);
    else if (f === 6 && w === 0) s.kind = r.uint32();
    else if (f === 7 && w === 1) s.startTimeUnixNano = r.fixed64().toString();
    else if (f === 8 && w === 1) s.endTimeUnixNano = r.fixed64().toString();
    else if (f === 9 && w === 2) attributesOf(r, s.attributes);
    else if (f === 11 && w === 2) {
      const e = r.sub();
      const ev = { timeUnixNano: "0", name: "", attributes: [] as KeyValue[] };
      e.fields((f2, w2) => {
        if (f2 === 1 && w2 === 1) ev.timeUnixNano = e.fixed64().toString();
        else if (f2 === 2 && w2 === 2) ev.name = str(e);
        else if (f2 === 3 && w2 === 2) attributesOf(e, ev.attributes);
        else return false;
      });
      s.events.push(ev);
    } else if (f === 13 && w === 2) {
      const l = r.sub();
      const link = { traceId: "", spanId: "", attributes: [] as KeyValue[] };
      l.fields((f2, w2) => {
        if (f2 === 1 && w2 === 2) link.traceId = hex(l.bytes());
        else if (f2 === 2 && w2 === 2) link.spanId = hex(l.bytes());
        else if (f2 === 4 && w2 === 2) attributesOf(l, link.attributes);
        else return false;
      });
      s.links.push(link);
    } else if (f === 15 && w === 2) {
      const st = r.sub();
      const status: { code?: number; message?: string } = {};
      st.fields((f2, w2) => {
        if (f2 === 2 && w2 === 2) status.message = str(st);
        else if (f2 === 3 && w2 === 0) status.code = st.uint32();
        else return false;
      });
      s.status = status;
    } else return false;
  });
  return s;
}

/** Decodes an ExportTraceServiceRequest protobuf. */
export function decodeTraceRequestProto(buf: Uint8Array): ResourceSpans[] {
  const out: ResourceSpans[] = [];
  const r = new Reader(buf);
  r.fields((f, w) => {
    if (f !== 1 || w !== 2) return false;
    const rs = r.sub();
    const resourceSpans: ResourceSpans = { scopeSpans: [] };
    rs.fields((f2, w2) => {
      if (f2 === 1 && w2 === 2) {
        const res = rs.sub();
        const attributes: KeyValue[] = [];
        res.fields((f3, w3) => (f3 === 1 && w3 === 2 ? attributesOf(res, attributes) : false));
        resourceSpans.resource = { attributes };
      } else if (f2 === 2 && w2 === 2) {
        const ss = rs.sub();
        const scopeSpans: ResourceSpans["scopeSpans"][number] = { spans: [] };
        ss.fields((f3, w3) => {
          if (f3 === 1 && w3 === 2) {
            const sc = ss.sub();
            const scope = { name: "", version: "", attributes: [] as KeyValue[] };
            sc.fields((f4, w4) => {
              if (f4 === 1 && w4 === 2) scope.name = str(sc);
              else if (f4 === 2 && w4 === 2) scope.version = str(sc);
              else if (f4 === 3 && w4 === 2) attributesOf(sc, scope.attributes);
              else return false;
            });
            scopeSpans.scope = scope;
          } else if (f3 === 2 && w3 === 2) scopeSpans.spans.push(span(ss.sub()));
          else return false;
        });
        resourceSpans.scopeSpans.push(scopeSpans);
      } else return false;
    });
    out.push(resourceSpans);
  });
  return out;
}

/** Decodes an OTLP/JSON ExportTraceServiceRequest (ids may be hex or base64, as exporters differ). */
export function decodeTraceRequestJson(text: string): ResourceSpans[] {
  const body = JSON.parse(text);
  const resourceSpans: ResourceSpans[] = body?.resourceSpans ?? body?.resource_spans ?? [];
  for (const rs of resourceSpans)
    for (const ss of rs.scopeSpans ?? [])
      for (const s of ss.spans ?? []) {
        s.traceId = normalizeId(s.traceId, 16);
        s.spanId = normalizeId(s.spanId, 8);
        if (s.parentSpanId) s.parentSpanId = normalizeId(s.parentSpanId, 8);
        s.startTimeUnixNano = String(s.startTimeUnixNano ?? "0");
        s.endTimeUnixNano = String(s.endTimeUnixNano ?? "0");
      }
  return resourceSpans;
}

function normalizeId(id: unknown, bytes: number): string {
  if (typeof id !== "string") return String(id ?? "");
  if (/^[0-9a-f]+$/i.test(id) && id.length === bytes * 2) return id.toLowerCase();
  try {
    const raw = atob(id);
    if (raw.length === bytes) return hex(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
  } catch {
    // not base64
  }
  return id;
}

/** Re-encodes resource spans as OTLP/JSON, for replaying into another Langfuse. */
export function encodeTraceRequestJson(resourceSpans: ResourceSpans[]): string {
  return JSON.stringify({ resourceSpans });
}
