---
title: TypeScriptでManifestを生成するGeneratorのアーキテクチャ
weight: 33
---

# TypeScriptでManifestを生成するGeneratorのアーキテクチャ

## アーキテクチャが解決すること

そもそも Generator そのものが解決することは manifest をドキュメントの乖離を防ぎ、YAMLの記法のぶれなどを防ぐことです。
アーキテクチャが解決しなければいけないことは、具体的には次のようなことが挙げられます。

1. マニフェスト自体のスケーラビリティを確保する
2. 実際に運用する際に必要最小限の変更だけで Manifest を更新できる ≒ 宣言的な変更で済むようにする
3. マイクロサービス単位で設定の変更ができる（CPU/MEM/replicas など）
4. 管理しているマイクロサービス全体のリソース量、変更時の増減が把握できる
5. Manifest ファイルの命名規則、出力先のディレクトリ・ファイルツリーなどを意識しなくても良い
6. Generator 自体の保守性を高める

これらを表現するためのアーキテクチャはStatic Site GeneratorやYeoman、Cookiecutter、Rails Scaffoldなどたくさん事例があります。
これらの基本的な骨格をKubernetesのManifest Generatorとして応用し次のようなアーキテクチャが設計しました。

![Manifest生成のためのアーキテクチャ](../manifest-architecture.svg)

それぞれの役割を紹介します。

| 名称                      | 役割                                                                                            |
| :------------------------ | :---------------------------------------------------------------------------------------------- |
| User Config               | バージョン変更など最小限の変更を与えるファイル                                                  |
| Kubernetes TypeDefinition | TypeScriptの型定義                                                                             |
| MicroService Template     | マイクロサービスの種類に応じたテンプレート                                                      |
| Definition                | `Namespace`名や`Port`番号、`Gateway`の Host 名などの不動値の定義                                |
| Resource                  | `Parameter`と`MicroService Template`を Kubernetes のリソースコンポーネント単位で結合する        |
| Factory                   | `Resource`をどのファイル名でどのグループで出力するか定義する                                    |
| Writer                    | Factory から与えられた情報から Kubernetes の Manifest や、CPU Requests などのレポートを生成する |

## 具体的な実装例

実装サンプルを以下のリポジトリに用意しました。`nodejs`と`pnpm`を利用したサンプルとなっています。
Docker Swarmを利用すればArgo Rollouts + Istioがデプロイできるところまで確認しています。

- https://github.com/Himenon/kubernetes-template

| Name                                       | PATH                                                                                                                 |
| :----------------------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| User Config                                | [config/\*.json](https://github.com/Himenon/kubernetes-template/tree/main/config)                                    |
| Kubernetes TypeDefinition                  | [src/k8s/\*](https://github.com/Himenon/kubernetes-template/tree/main/src/k8s)                                       |
| MicroService Template                      | [src/templates/\*](https://github.com/Himenon/kubernetes-template/tree/main/src/templates)                           |
| Definition                                 | [src/definitions/\*](https://github.com/Himenon/kubernetes-template/tree/main/src/definitions)                       |
| Factory                                    | [src/factory/\*/index.ts](https://github.com/Himenon/kubernetes-template/blob/main/src/factory/basic/index.ts)       |
| Resource                                   | [src/factory/\*/resource.ts](https://github.com/Himenon/kubernetes-template/blob/main/src/factory/basic/resource.ts) |
| Writer                                     | [src/writer/\*](https://github.com/Himenon/kubernetes-template/tree/main/src/writer)                                 |

依存関係は[sverweij/dependency-cruiser](https://github.com/sverweij/dependency-cruiser)のカスタムルールによってテストしています。

* https://github.com/Himenon/kubernetes-template/blob/main/.dependency-cruiser.js#L4-L94

Writerが出力するファイルは以下の通り。

* `kubectl apply -k overlays/[env]/`が可能なディレクトリ群
    * https://github.com/Himenon/kubernetes-template/tree/main/overlays
* `production`で利用するリソースのレポート
    * https://github.com/Himenon/kubernetes-template/blob/main/report/resource-table.md

## 特徴的なこと

### ConfigMapの更新した後にPodを再起動する

例えばDeploymentがConfigMapの設定によって動作を変化させるような場合、ConfigMapだけを更新してもロールアウトは発生しません。

> Deploymentのロールアウトは、DeploymentのPodテンプレート(この場合.spec.template)が変更された場合にのみトリガーされます。例えばテンプレートのラベルもしくはコンテナーイメージが更新された場合です。Deploymentのスケールのような更新では、ロールアウトはトリガーされません。
> 
> 引用: [Deploymentの更新](https://kubernetes.io/ja/docs/concepts/workloads/controllers/deployment/#updating-a-deployment)

これを対処するには例えばConfigMapのContentHashを計算して、
それをPod TemplateのAnnotationに付与することでConfig MapとDeploymentの関係性を作れます。

```ts
import { createHash } from "crypto";

export const createContentHash = (text: string): string => {
  const hash = createHash("md4");
  hash.update(text);
  return hash.digest("hex");
};
```

```yaml
kind: Deployment
spec:
  template:
    metadata:
      annotations:
        # Content Hashの値は依存するConfigMapに対して計算する。
        dependency.config-map.content-hash: bf84e528eaedf3fd7c3c438361627800
```

これのApplyの順番はArgo CDの[Sync Wave](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)を利用すると簡単に制御できます。

### Reportを作成するスクリプトは`NonNull Assertion`を許可する

TypeScriptで書いてると厳密に型定義を守ることが開発の安全に繋がりますが、**Writer**の種類によっては2つの理由でこれを許容します。

1. 細かく定義するコストが高い
2. レポートとして自動生成するようなパラメーターは"そもそも必須"であるため、マニフェスト生成時にエラーになってくれたほうが良い

前者は消極的な理由ですが、後者は先程紹介した`実装内でExceptionを発生させる`と同じ意味合いを持っています。
つまり、`obj.a?.b?.c`で参照するよりも`obj.a!.b!.c!`で参照すると、型チェックして`throw new Error`をする手間が省ける算段です。
もしくは、生成されたレポートがおかしな状態になるのでレビューで簡単に防ぐことができます。

* [実装例](https://github.com/Himenon/kubernetes-template/blob/main/src/writer/report-writer/report-writer.ts)

## Manifest生成はどう使うのがよいか？

### リポジトリ運用について

`namespace`単位で管理するのが楽でしょう。ただし、機密情報がある場合は`secret`だけまとめたリポジトリを別途切るのは必要です。
`namespace`内は基本的に競合する`.metadata.name`を作ることはできません、加えて仮に同じ名前にしても管理が複雑になります。

### ツールについて

ここで紹介したのは、愚直にKubernetesなどが提供しているOpenAPI Schemaから型定義を生成したものを利用した例でした。
KubernetesのドキュメントにはREST API経由でKubernetes APIをCallするClient Libraryとしていくつか紹介されています。

* https://kubernetes.io/docs/reference/using-api/client-libraries/

これを純粋にREST APIのClientとして使うだけでなく、Manifestを生成するために役立てることも可能でしょう。
YAMLで書くには複雑になりすぎた場合に、チームで使い慣れた言語で記述する選択肢も用意されているので一考する価値はあるでしょう。

### Generatorを辞めたくなったら

YAMLだけ残して後の実装はさっぱり捨ててしまいましょう。YAMLだけあればKubernetesにデプロイは可能ですから。
