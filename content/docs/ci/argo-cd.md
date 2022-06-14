---
title: Argo CDの利用
weight: 41
description: Argo CDを利用することでGitOpsを実現しました。加えて複数のアプリケーションをモノレポで管理する際の利点について言及します。
---

# Argo CD

ニコニコ生放送のフロントエンドではContinuous Delivery(以降CD)ツールとしてArgo CDとArgo Rolloutsを利用しています。
ここではその運用と設計について紹介します。

**注意書き**

* `argoproj.io/v1alpha1/Application`のことを「ArgoCDのApplication」と表記します。

## 他チームとの棲み分け

Argo CDはフロントエンドのチームだけではなく、他のチームが管理するものも存在しています。
したがってチーム横断で管理している部分が存在するとレビューコストが上がるため、[App of Apps Patterns](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/)を利用して管理するArgocd Applicationをフロントエンドチームのnamespaceで分離しました。

具体的にはapp of appsを2段階で利用して次の図ように分離しています。

![App of Appsの概略図](../app-of-apps.svg)

図中の`Root ArgoCD Apps`は他チームと干渉する部分になっています。
ここに、フロントエンドチームが管理するArgoCD Appsを配置します

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: frontend-apps
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    targetRevision: master
    repoURL: # フロントエンドチームが管理するapp of appsパターンの親リポジトリ
    path: kubernetes/overlays/[環境名]
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated: {}
```

これにより、ArgoCD上で他チームと干渉する場所が木の間にマニフェストファイルが絞り込まれました。

## フロントエンドのチームが管理するマイクロサービスのためのリポジトリとArgoCDのApplication設定

フロントエンドチームが管理するマイクロサービスのManifestは2つのリポジトリで管理しています。

1. `secret`
1. `infrastructure`

`secret`はKubernetesのSecretに対応するコンポーネントを格納するリポジトリで、機密情報が含まれるため権限がなければRead/Writeできないリポジトリ設定です。
`infrastructure`のリポジトリはフロントエンドチームが管理するすべてのマイクロサービスのManifestが集約されています。

`infrastructure`は具体的には次のようなディレクトリ構成になっています。

```
kubernetes/overlays
├── production
│   ├── app1
│   ├── app2
│   ├── ...
│   ├── ...
│   └── appN
├── [env2]
├── [env3]
├── ...
├── ...
└── [envN]
    ├── app1
    ├── app1
    ├── ...
    ├── ...
    └── appN
```

もう少し平たく書くと、

```
kubernetes/overlays/[デプロイ環境]/[マイクロサービス名]
```

したがって、フロントエンドのチームが管理するArgoCDのapp of appsの親は次のようなArgoCDのApplicationがそれぞれのパスを散所するようにずらっと並んでいます。

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: datadog
  finalizers:
    - resources-finalizer.argocd.argoproj.io
  annotations:
    notifications.argoproj.io/subscribe.slack: "Slack Channel Name"
    argocd.argoproj.io/sync-wave: "-100"
spec:
  project: default
  source:
    repoURL: [REPOSITORY URL]
    targetRevision: master
    # ここのパターンの分だけファイル数がある
    path: kubernetes/overlays/[デプロイ環境]/[マイクロサービス名]
  destination:
    server: https://kubernetes.default.svc
    namespace: frontend
  syncPolicy:
    automated:
```

一見するとファイル数はとても多くなりますが、[TypeScriptでManifestを生成している](../../manifest/manifest-management)ため、ファイル数の量は問題ではありません。


## フロントエンドが管理するマイクロサービスのためのManifestのリポジトリ

前節ですでに先んじで登場していますが、`infrastructure`のリポジトリ内にフロントエンドチームが管理するマイクロサービスのすべてがあります。

![エディタの画面](../editor-view.png)

まず、`infrastructure`各マイクロサービスのリポジトリ（NodeJSなどの具体的な実装）からは分離されています。
これは[Best Practice](https://argo-cd.readthedocs.io/en/stable/user-guide/best_practices/)に則っています。

次に、1つのリポジトリでチームが管理するすべてのManifestが存在している理由は次の点が挙げられます

### メニーレポで管理しない理由

1. メニーレポ（複数のリポジトリ）で管理すると保守するときの更新が大変である

### モノレポで管理する理由

1. 全体最適化が容易になる
1. Webフロントエンドのアプリケーションは1つのhostに対してルーティングが存在するため全体を見て調整するケースが有る
   - 後述しますが[Global RateLimit](../../rate-limit/global-ratelimit)などがその例
2. 1つのマイクロサービスに複数のルーティング先が存在するが、デプロイ単位として分割したい場合の管理

これらはWebフロントエンドの開発時にnpmパッケージをモノレポで管理しているところからの発想もあり、モノレポのほうが開発や保守効率が圧倒的に早いことが経験則としてわかっていることも決め手の背景としてあります。

[Slack Botによる自動化](../../ci/slack-bot)で改めて紹介しますが、結果的にモノレポで管理した事によってBotによる更新が容易になり、マニフェストの変更から本番デプロイまでが5分以内で終わるスピーディなリポジトリなっています。もはやBotユーザーしかリポジトリの更新をしていない状態です。

## `infrastructure`リポジトリのブランチ設計

マイクロサービスをKubernetesクラスターにデプロイするためのブランチは以下の2つしか用意していません。

```
master               .... 開発環境にリリースされるブランチ（Defaultブランチ）
release/production   .... 本番リリース用のブランチ
```

`kustomize`が提案するブランチ運用の場合、各環境ごとにデプロイするブランチが存在しますが、開発環境においてはDefaultブランチにマージした場合はすべての開発環境に問答無用でデプロイされるようにしています。

理由はいたって単純で、デプロイする環境数が多く、わざわざ各環境用にデプロイするためのPull Request作成からマージまでのリードタイムは非常に遅いと判断したためです。

### masterブランチはSquash Mergeのみ許容する

モノレポにしていることもありたくさんのPull Requestが`infrastructure`リポジトリに飛んできます。
するとcommit履歴も比例して多くなります。
通常Merge CommitでGitHubのPull Requestを処理した場合、Pull Request中で変更した内容と`Merge pull request`のコミットが一気に追加されるため、
GitOpsを運用しているリポジトリでこれを実施するとcommit履歴が単純に荒れます。
これを防ぐため、masterブランチに対するマージはSquash Mergeのみを許可し、必ずPull Request一つに対してcommitが1つになるように実施しています。

また、`release/production`ブランチに関してはリリース用のブランチであるため、こちらは`Merge Commit`のみを許容しています。Squash Mergeを実施した場合は`master`に対してバックポート処理が必要になるためです。
さらに、2つのブランチで異なるMerge方法をGitHuのルールで強制することができないため、Slack Botによるマージ処理の自動化も実施しています。

### masterブランチに入ったものは必ずいつでもリリースして良いものとして扱う

manifestをモノレポで運用しているため、共生している他のマイクロサービスが別のマイクロサービスと同時にリリースされる可能性があります。
すなわち、本番環境にリリースしたくない変更は`master`ブランチに入れなければ良いだけになります。
また、特定の環境だけバージョンを上げたいときの手続きが長いといった要望は明らかに予想可能な問題なため、同時にSlack Botによってデプロイの簡略化と自動化を実現しています。

### `release/production`ブランチに対してPull Requestを投げたとき同時にtagとリリースノートを作成する

`release/production`に対するPull Requestは不可逆の処理として扱います。
リリースすべきでない変更が入っている場合は`master`にコミットした後、改めて`release/production`に対してPull Requestを投げます。
このときもtagとリリースノートを同時に作成します。
すでに切られたtagやリリースノートは削除せずどんどん新しいものを使っていく運用になっています。
tagやリリースノートを削除して新しく新規のバージョンで切る方法もありますが、これはたくさんの変更を受け付ける際にコンフリクトしやすく、
運用が難しいため、運用が簡単で速度が出やすい欠番方式を採用しています。

## デプロイの速度が重要な理由

ここまで紹介してきた方法はすべて「デプロイの速度を落とさないため」に実施しています。
速度に拘る理由は、「遅くする理由がないから」です。
Kubernetes上で障害が発生したときは一時的にCLIや管理用のDashboardからRollbackの処理などを実施することができます。
しかしながらそれだけでは対応できない構成変更やアプリケーションの再投入が必要な場合に、デプロイの部分が遅ければそれだけ影響の受けるユーザーが多く、損失も大きくなります。
逆コンウェイの法則然り、最速でデプロイできるフローに運用の手続きをあわせていくことがこの場合、あらゆる面で有効であるため、最速のデプロイフローを作ることに拘っています。
こう見ると安全にデプロイできるかという話がありますが、それは自動化によって対処すべき話であるため別途紹介します。
