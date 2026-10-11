// The Vercel function. The handler (server/vercel-handler.ts) and the server it imports are
// bundled into one file by scripts/build-api.mjs during `pnpm build`, so a cold start loads a
// single module instead of resolving and compiling every server file.
// Source maps are enabled before the bundle loads, so stack traces name server/... files.
process.setSourceMapsEnabled(true);
const { default: handler } = await import('./_bundle/index.mjs');
export default handler;
