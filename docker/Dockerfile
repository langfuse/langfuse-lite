# langfuse-lite: Langfuse web + worker with embedded stand-ins, in one image.
#
# Built by scripts/build-image.sh, which stages the build context (portable
# Python with the shims' packages, the shims, a pre-migrated database snapshot)
# so this build needs no network beyond the base images.
ARG LANGFUSE_TAG=4
FROM docker.langfuse.com/langfuse/langfuse-worker:${LANGFUSE_TAG} AS worker
FROM redis:7.4-bookworm AS redis

FROM docker.langfuse.com/langfuse/langfuse:${LANGFUSE_TAG}
USER root
# The worker app is self-contained under /app/worker.
COPY --from=worker /app/worker /app/worker
# Needs only glibc 2.34 and OpenSSL 3, both in this image.
COPY --from=redis /usr/local/bin/redis-server /opt/lite/bin/redis-server
COPY python /opt/lite/python
COPY site-packages /opt/lite/site-packages
COPY shims /opt/lite/shims
COPY lite.env /opt/lite/lite.env
COPY --chmod=755 entrypoint.sh /opt/lite/entrypoint.sh
RUN mkdir -p /data && chown 1001:1001 /data
# Last, because it changes on every build: the database snapshot copied to
# /data on first start (migrated, default models and dashboards, lite-org).
COPY --chown=1001:1001 seed /opt/lite/seed
USER 1001
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=2s --timeout=3s --start-period=120s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/public/health || exit 1
ENTRYPOINT ["dumb-init", "--single-child", "--", "/opt/lite/entrypoint.sh"]
CMD []
