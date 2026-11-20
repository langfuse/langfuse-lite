// The one-page viewer served at /: traces (waterfall tree with input, output,
// usage and cost per observation) and experiment runs (item-by-item compare).
import html from "./viewer.html" with { type: "text" };

// Bun's types call an .html import an HTMLBundle; with type "text" it is the file's text.
export const VIEWER_HTML = html as unknown as string;
