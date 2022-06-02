import fs from "fs";
import path from "path";

let doc = fs.readFileSync("tex-workspace/sub/article.tex", "utf-8");

const list = doc.match(/includegraphics{(?<uri>[\w\s\.\/-]+)}/g);

const lineWidthTargets = [
  "istio-ingress-gateway.svg"
];

list.forEach((item) => {
  const matched = item.match(/includegraphics{(?<uri>[\w\s\.\/-]+)}/);
  if (!matched) {
    return;
  }
  const { uri } = matched.groups || {};
  if (!uri) {
    return;
  }
  const basename = path.basename(uri);
  if (path.extname(basename) === ".svg") {
    const isLineWidth = lineWidthTargets.includes(basename);
    const pdfBasename = basename.replace(".svg", "_cropped.pdf");

    if (isLineWidth) {
      doc = doc.replace(new RegExp(item, "g"), `includegraphics[width=\\linewidth]{./sub/${pdfBasename}}`);
    } else {
      doc = doc.replace(new RegExp(item, "g"), `includegraphics{./sub/${pdfBasename}}`);
    }
  } else {
    doc = doc.replace(new RegExp(item, "g"), `includegraphics[width=\\linewidth]{./sub/${basename}}`);
  }
});


// Replace: KaTeX Syntax
doc = doc.replace(/\\{\\{\\textless{} katex display \\textgreater\\}\\}/g, "\\begin{align*}");
doc = doc.replace(/\\{\\{\\textless{} \/katex[\n|\r\n|\s]\\textgreater\\}\\}/g, "\\end{align*}")

fs.writeFileSync("tex-workspace/sub/article-formatted.tex", doc, "utf-8");
console.log(`Generate: article-formatted.tex`);

