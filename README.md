# Kubernetes Migrate Book 2022

## Develop

```bash
hugo server -D
```

## Deploy

After merging into the main branch, create a release.

## Develop

```bash
pnpm install
```

Generate PDF

* `pnpm run build`
  1. Generate Source Markdown for pandoc
  2. Generate TeX File by pandoc
  3. Update TeX File
  4. Copy PNG / PDF
  5. Generate DVI File (width toc file)
  6. Generate DVI File
  7. Covert DVI to PDF

**Generate Graphic PDF**

1. Download PDF from [diagrams (draw.io)](https://app.diagrams.net/)
2. Separate PDF by `pdfseparate` (poppler)
   * [Docker Image](https://hub.docker.com/r/minidocks/poppler)
3. Crop PDF by `pdf-crop-margins`
   * [Docker Image](https://github.com/Himenon/pdfCropMargins-docker/pkgs/container/pdf-crop-margins)

## LICENSE

Shield: [![CC BY 4.0][cc-by-shield]][cc-by]

This work is licensed under a
[Creative Commons Attribution 4.0 International License][cc-by].

[![CC BY 4.0][cc-by-image]][cc-by]

[cc-by]: http://creativecommons.org/licenses/by/4.0/
[cc-by-image]: https://i.creativecommons.org/l/by/4.0/88x31.png
[cc-by-shield]: https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg
