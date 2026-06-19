import esbuild from "esbuild"

const production = process.argv.includes("--production")

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.cjs",
  sourcemap: !production,
  minify: production,
})
