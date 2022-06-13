import fs from "fs";
import matter from "gray-matter"

const toc = [
  "content/_index.md",
  "content/docs/network/architecture.md",
  "content/docs/manifest/manifest-management.md",
  "content/docs/manifest/kubernetes-manifest-written-by-typescript.md",
  "content/docs/manifest/kubernetes-manifest-generator-architecture.md",
  "content/docs/ci/argo-cd.md",
  "content/docs/ci/argo-rollouts.md",
  "content/docs/ci/slack-bot.md",
  "content/docs/service-mesh/istio.md",
  "content/docs/service-mesh/access-log.md",
  "content/docs/service-mesh/traffic-management.md",
  "content/docs/rate-limit/global-ratelimit.md",
  "content/docs/rate-limit/local-ratelimit.md",
  "content/docs/rate-limit/ratelimit-is-unless.md",
  "content/docs/scalability/horizontal-pod-autoscaler.md",
  "content/docs/performance/load-test.md",
  "content/docs/performance/monitoring.md",
  "content/docs/performance/load-balancing.md",
  "content/docs/migrate-practice/application.md",
  "content/docs/migrate-practice/migrate-docker-swarm-to-kubernetes.md",
];

/**
 *
 * @param {string} doc
 */
const replaceCodeBlock = (doc) => {
  // return doc.replace(/```(.*)/g, "```");
  let inCodeBlock = false;
  return doc.split("\n").map(line => {
    if (!line.startsWith("```")) {
      return line;
    }
    const [, codeInfo] = line.split("```");
    const [lang, more] = codeInfo.split(" ");
    const formattedLang = {
      "yml": "yaml",
      "ts": "typescript",
    }[lang] || lang;
    const ignore = ["nginx.conf", "conf"].includes(formattedLang);
    if (ignore || (!formattedLang && !inCodeBlock)) {
      return line.replace(/```(.*)/g, "```");
    }
    const statement = inCodeBlock ? `\\end{minted}` : `\\begin{minted}[breaklines, bgcolor=LightGray]{${formattedLang}}`;
    inCodeBlock = !inCodeBlock;
    return statement;
  }).join("\n")
};

const main = () => {
  fs.mkdirSync("tex-workspace/sub", { recursive: true });
  const writeStream = fs.createWriteStream("tex-workspace/sub/article.md", "utf-8");
  toc.map((item) => {
    const doc = fs.readFileSync(item, "utf-8");
    const { content } = matter(doc);
    const newDoc = replaceCodeBlock(content);
    writeStream.write(newDoc)
  });
  writeStream.close();
};

main();
