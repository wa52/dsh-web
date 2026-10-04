const fs = require("fs");
const os = require("os");
const path = require("path");

function patchFile(target, oldText, newText, marker, label) {
  if (!fs.existsSync(target)) {
    console.warn(`[fix-dsh-fence] ${label} not found:`, target);
    return;
  }
  const source = fs.readFileSync(target, "utf8");
  if (source.includes(marker)) {
    console.log(`[fix-dsh-fence] ${label} already patched:`, target);
    return;
  }
  if (!source.includes(oldText)) {
    console.warn(`[fix-dsh-fence] ${label} expected block not found; package may have changed. Patch skipped.`);
    return;
  }
  fs.writeFileSync(target, source.replace(oldText, newText), "utf8");
  console.log(`[fix-dsh-fence] ${label} patched:`, target);
}

const connectionPkg = require.resolve("@deepseek-ai/dsh-client-connection/package.json");
const connectionTarget = path.join(path.dirname(connectionPkg), "lib", "index.js");
const connectionOld = [
  "\ttry {",
  "\t\treturn new URL(origin).host === hostUrl.host;",
  "\t} catch {",
  "\t\treturn false;",
  "\t}",
].join("\n");
const connectionNew = [
  "\ttry {",
  "\t\tconst originUrl = new URL(origin);",
  "\t\tif (originUrl.host === hostUrl.host) return true;",
  "\t\treturn originUrl.port === \"\" && originUrl.hostname === hostUrl.hostname;",
  "\t} catch {",
  "\t\treturn false;",
  "\t}",
].join("\n");

patchFile(connectionTarget, connectionOld, connectionNew, "originUrl.port", "dsh-client-connection");

const codexProfileRoot = path.join(os.homedir(), ".dsh", "profiles", "web");

let marketPkg;
try {
  marketPkg = require.resolve("dshmarket/package.json", { paths: [codexProfileRoot] });
} catch {
  console.warn("[fix-dsh-fence] dshmarket is not installed in the web profile. Patch skipped.");
}

if (marketPkg !== undefined) {
  const marketRoot = path.dirname(marketPkg);
  const marketJsTarget = path.join(marketRoot, "lib", "http.js");
  const marketJsOld = [
    "    try {",
    "        return new URL(origin).host === host;",
    "    }",
    "    catch {",
    "        return false;",
    "    }",
  ].join("\n");
  const marketJsNew = [
    "    try {",
    "        const originUrl = new URL(origin);",
    "        const hostUrl = new URL(`${originUrl.protocol}//${host}`);",
    "        if (originUrl.host === hostUrl.host)",
    "            return true;",
    "        return originUrl.port === '' && originUrl.hostname === hostUrl.hostname;",
    "    }",
    "    catch {",
    "        return false;",
    "    }",
  ].join("\n");

  patchFile(
    marketJsTarget,
    marketJsOld,
    marketJsNew,
    "originUrl.port === '' && originUrl.hostname === hostUrl.hostname",
    "dshmarket runtime",
  );

  const marketTsTarget = path.join(marketRoot, "src", "http.ts");
  const marketTsOld = [
    "  try {",
    "    return new URL(origin).host === host",
    "  } catch {",
    "    return false",
    "  }",
  ].join("\n");
  const marketTsNew = [
    "  try {",
    "    const originUrl = new URL(origin)",
    "    const hostUrl = new URL(`${originUrl.protocol}//${host}`)",
    "    if (originUrl.host === hostUrl.host) return true",
    "    return originUrl.port === '' && originUrl.hostname === hostUrl.hostname",
    "  } catch {",
    "    return false",
    "  }",
  ].join("\n");

  patchFile(
    marketTsTarget,
    marketTsOld,
    marketTsNew,
    "originUrl.port === '' && originUrl.hostname === hostUrl.hostname",
    "dshmarket source",
  );
}

let codexPkg;
try {
  codexPkg = require.resolve("dsh-codex-connect/package.json", { paths: [codexProfileRoot] });
} catch {
  console.warn("[fix-dsh-fence] dsh-codex-connect is not installed in the web profile. Patch skipped.");
  process.exit(0);
}

const codexLib = path.join(path.dirname(codexPkg), "lib");
const codexTarget = fs.readdirSync(codexLib)
  .filter((name) => /^src-.*\.js$/u.test(name))
  .map((name) => path.join(codexLib, name))
  .find((candidate) => fs.readFileSync(candidate, "utf8").includes("function exactOrigin(req, rawHost, rawOrigin)"));

if (codexTarget === undefined) {
  console.warn("[fix-dsh-fence] dsh-codex-connect runtime bundle not found. Patch skipped.");
  process.exit(0);
}

const codexOld = [
  "function exactOrigin(req, rawHost, rawOrigin) {",
  "\ttry {",
  "\t\tconst effective = normalizeTrustedOrigin(`${req.socket.encrypted === true ? \"https\" : \"http\"}://${rawHost}`);",
  "\t\treturn normalizeTrustedOrigin(rawOrigin) === effective;",
  "\t} catch {",
  "\t\treturn false;",
  "\t}",
  "}",
].join("\n");
const codexNew = [
  "function exactOrigin(req, rawHost, rawOrigin) {",
  "\ttry {",
  "\t\tconst effective = new URL(normalizeTrustedOrigin(`${req.socket.encrypted === true ? \"https\" : \"http\"}://${rawHost}`));",
  "\t\tconst candidate = new URL(normalizeTrustedOrigin(rawOrigin));",
  "\t\tif (candidate.origin === effective.origin) return true;",
  "\t\treturn candidate.protocol === effective.protocol && candidate.port === \"\" && candidate.hostname === effective.hostname;",
  "\t} catch {",
  "\t\treturn false;",
  "\t}",
  "}",
].join("\n");

patchFile(
  codexTarget,
  codexOld,
  codexNew,
  "candidate.protocol === effective.protocol && candidate.port",
  "dsh-codex-connect",
);
