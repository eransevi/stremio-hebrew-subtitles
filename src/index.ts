import { handleSubtitles } from "./stremio";
import { info, warn, error } from "./logger";

function addCorsHeaders(response: Response) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  return response;
}

export default {
  fetch: async (req: Request, env: any) => {
    const url = new URL(req.url);
    info("Incoming request", { method: req.method, path: url.pathname });

    try {
      if (req.method === "OPTIONS") {
        const res = new Response(null, { status: 204 });
        return addCorsHeaders(res);
      }

      if (url.pathname === "/manifest.json") {
        info("Serving manifest", url.pathname);
        const res = Response.json({
          id: "com.hebrew.subtitles.ai",
          version: "1.0.0",
          name: "Hebrew AI Subtitles",
          resources: ["subtitles"],
          types: ["movie", "series"],
          idPrefixes: ["tt"]
        });
        return addCorsHeaders(res);
      }

      if (url.pathname.startsWith("/subtitles/")) {
        const res = await handleSubtitles(req, env);
        return addCorsHeaders(res);
      }

      warn("Route not found", url.pathname);
      const res = new Response("Not found", { status: 404 });
      return addCorsHeaders(res);
    } catch (err) {
      error("Unhandled fetch error", err);
      const res = new Response("Internal server error", { status: 500 });
      return addCorsHeaders(res);
    }
  }
};