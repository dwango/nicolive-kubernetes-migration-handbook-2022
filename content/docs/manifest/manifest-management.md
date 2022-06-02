---
title: KubernetesのManifest管理
weight: 31
---

# Kubernetes の Manifest 管理

ここではManifestの管理をどのように実施しているかについて紹介します。
結果から言えば、Kubernetesで利用するManifestを生成するGeneratorをTypeScriptで構築しました。

どのように構築して運用しているのか説明していきます。

## 移行後の各Componentのファイル数の規模感

[導入](/docs/01/introduction/#kubernetesでの稼働規模)でも提示していますが改めて、**フロントエンドに関係するマイクロサービス**に関係するManifestは以下の規模で存在しています。
これは簡単に管理するとは言えないコンポーネント数があり、これからも増えていきまうｓ．

| Component                                  | ファイル数 |
| :----------------------------------------- | ---------: |
| v1/Deployment                              |         20 |
| v1/Service                                 |         60 |
| v1/Config Map                              |         15 |
| batch/v1/Job                               |         15 |
| argoproj.io/v1alpha1/Rollout               |         20 |
| networking.istio.io/v1beta1/VirtualService |         20 |
| networking.istio.io/v1alpha3/EnvoyFilter   |         20 |

## 問題意識

移行前の段階ですでにファイル数はYAMLで保守するには困難な量が発生することはわかっており、ツールによる補完支援やテスト無しでは必ず破綻することが容易に想定されました。また、これらは最初に定めた2つの目標に反します。

* デプロイが素早く簡単にそして安全に実施できる
* Webnフロントエンド開発者が更新に必要な最低限の設定の変更を簡単に実施できる

### TypeScriptでManifestの保守面の問題を解決する

これらを網羅的に解決する一つの方法としてTypeScriptによりKubernetesのYAMLを生成することです。
TypeScript自体の利点は各種記事に譲るとして、Kubernetesを運用するチームの背景としてTypeScriptを日常的に利用しているWebフロントエンドのエンジニアたちです。

したがって、TypeScriptでManifestを記述すること自体は非常に障壁がほとんど皆無という状態です。
またManifest自体のテストもTypeScriptからYAMLを生成するタイミングで`Exception`を投げてしまえば良いだけなので、テストの方針も非常に単純になります。

仮にTypeScriptで書くのを辞めたいといった場合は生成されたYAMLを持っていけば良いので、TypeSCript自体を切り捨てることも簡単になります。

以上の理由からTypeScriptで記述しない理由が移行の設計段階で存在しないため、ManifestをYAMLで書くことを初手で捨て、TypeScriptで記述するようにしました。

## TypeScriptでKubernetesを書くための支援ライブラリとSchema

Kubernetesは`CustomResourceDefinition`を定義する際OpenAPI Schema V3で記述できます。
これによってSchemaがApply時にValidationされています。
逆に言えば、OpenAPI SchemaをTypeScriptの型定義に書き起こしてしまえばValidationをTypeScriptの静的型付けに変換することができます。

幸いにして筆者はOpenAPI SchemaとTypeScriptの話にはちょっとだけ詳しいので、
手前味噌ですが[@himenon/openapi-typescript-code-generator](https://github.com/Himenon/openapi-typescript-code-generator)を利用してKubernetesの型定義を生成しました。

* [@himenon/kubernetes-typescript-openapi](https://github.com/Himenon/kubernetes-typescript-openapi)
* [@himenon/argocd-typescript-openapi](https://github.com/Himenon/argocd-typescript-openapi)
* [@himenon/argo-rollouts-typescript-openapi](https://github.com/Himenon/argo-rollouts-typescript-openapi)

もちろん他にも同じようなアプローチで型定義を提供しているものもありますが、以下の点で見送りをしています。

- TypeScriptのObjectに対してシンプルに型定義を当てたい
    - これはライブラリ側のメンテナンスが滞っても自分たちで書き直すことができるため
- ArgoCDやArgoRollouts、Istioなど他のCustom Resource利用時も同じライブラリの使い勝手になるようにしたい
- 最新だけでなく任意の古いバージョンもサポートするようにする

これらを考えたときになるべくライブラリは薄く実装されているのが望ましく、型定義ライブラリをForkしたときも簡単にメンテナンスできる実装ベースが必要でした。これらの条件を満たす設計コンセプトで豊富な知見があるライブラリは[@himenon/openapi-typescript-code-generator](https://github.com/Himenon/openapi-typescript-code-generator)でした。

次の節でより詳細に紹介します。

- [TypeScriptでKubernetesのmanifestを記述する](../kubernetes-manifest-written-by-typescript/)
- [TypeScriptでManifestを生成するGeneratorのアーキテクチャ](../kubernetes-manifest-generator-architecture/)

## 他のライブラリ

Kubernetes向けTypeScriptのライブラリ

* [cdk8s](https://github.com/cdk8s-team/cdk8s)
* [kosko](https://github.com/tommy351/kosko)

KubernetesのDefinitionが定義れているComponentは[CustomResourceDefinition](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/)があります。

