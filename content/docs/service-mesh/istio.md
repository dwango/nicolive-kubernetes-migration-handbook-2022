---
title: BFFとIstio
weight: 51
---

# BFFとIstio

## Istio の利用

Istio は既存のマイクロサービスに対して後付で導入することができ、
通信を可観測にしたり、負荷分散を実施したり、Proxy としての機能を持っています。
Kubernetes 上で稼働するマイクロサービスの通信をよりプログラマブルに扱える機能を提供しています。

実際に触ってみると istioが謳っているこれらの機能は有用で、サービスメッシュはKubernetesを運用する上で必要不可欠であることを実感させられます。

さて、詳細な部分はドキュメントを読むのが望ましいですが、とっつきにくい部分もあるのでフロントエンドのエンジニアが使うと便利な機能を紹介しつつ
Istio のコンポーネント紹介します。

## IstioとEnvoyの関係

まずはIstioとEnvoyの関係について知っておく必要があります。

Envoyはそれ自体がProxyであり、nginxやApacheなどのL7 LBと似たような機能を提供しています。
大きな違いとして、Envoy はテレメトリが標準で豊富だったり、APIによる構成変更が可能だったりプログラマブルにコントロールできる機能を豊富に持っています。
すなわち再起動をせずに構成変更が容易であり、[Argo RolloutsのCanary Deploy](/docs/04/argo-rollouts/#canary-deployを実施する)で紹介したように Traffic Weight を柔軟に変更することが可能になります。

IstioはこのEnvoyを利用して、Kubernetes上で稼働するマイクロサービス間の通信を観測するために Control Plane から各 Pod に Sidecar として注入します。
Istioから提供されているEnvoyのDocker Imageは`istio-proxy`という名前で提供されており、`kubectl get pod [podname]`などで構成を確認すると`istio-proxy`という名前を確認することができます。

Envoy 単体では通常以下のような YAML を記述して起動時に読み込ませることで Envoy の設定変更を実施します。

- https://www.envoyproxy.io/docs/envoy/latest/configuration/overview/examples

Istio の場合、Envoy はすでに起動された状態で存在しているため、既存の設定が存在しています。
そのため、この構成変更をしたい場合は`EnvoyFilter`を利用します。

- https://istio.io/latest/docs/reference/config/networking/envoy-filter/

ただ普段書くような Traffic Management 用の設定は別のコンポーネントを利用して簡易に記述することができます。

| Component 名    | 役割                                                                                                                                |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| Gateway         | 受け入れ可能なホスト名、ポート番号、プロトコルなどを記述する                                                                        |
| Virtual Service | `PATH`単位のルーティングの設定が可能。Traffic Weight の指定、Header や Query Parameter による個別のルーティング先もここで指定する。 |
| Service Entry   | Kubernetes クラスタから外部へのアクセス制限など。                                                                                   |

その他（<https://istio.io/latest/docs/reference/config/networking>）にもComponentはありますが最初に指定するものはおおよそ上記の3つでしょう。

## Ingress Gatewayをセットアップする

IstioはSidecarにistio-proxyを注入するだけではなく、Ingress Gatewayを作成することでその機能をより活かすことができます。

IngressGatewayは`namespace`やKubernetesの境界に位置するGatewayとして機能させることで管理下にあるマイクロサービスに対するアクセスの制御ができます。
Webフロントエンドが管理するような、Internetからアクセスされ、他マイクロサービスから直接CALLが必要ないマイクロサービスはIngress Gatewayを通して管理すると負荷対策やデプロイの運用が楽になります。

![istio ingress gatewayの概略図](../istio-ingress-gateway.svg)

IstioにおけるIngress Gatewayのセットアップは`IstioOperator`利用して実施します。

* https://istio.io/latest/docs/setup/install/operator/

### istio-system以外のnamespaceでIstioOperatorが利用できるようにする

IstioOperatorの管理をnamespaceを分けて管理したい場合、デフォルトの設定のままではインストールすることができません。例えば以下のようにIstioOperator(`Deployment`)をセットアップすると`watchedNamespaces`で指定された`istio-system`でのみ`IstioOperator`のコンポーネントが利用できません。

```bash
$ helm install istio-operator manifests/charts/istio-operator \
  --set watchedNamespaces=istio-system \
  -n istio-operator \
  --set revision=1-9-0
```

すでにインストールされた環境下の場合、次のようなコマンドでIstioOperatorが利用可能なnamespaceを確認することができます。

```bash
kubectl get deployment -n istio-operator -l operator.istio.io/component=IstioOperator -o yaml | grep -A1 "name: WATCH_NAMESPACE"
```

環境変数`WATCH_NAMESPACE`を更新することで`IstioOperator`のコンポーネントが利用することができるようになります。
例えば`myteam`という`namespace`を追加したい場合は次のように実施します。

```bash
kubectl set env deployment/istio-operator-1-11-4 WATCH_NAMESPACE="istio-system,myteam" -n istio-operator
```

Ingress Gatewayの具体的な設定は[次の節](/docs/05/traffic-management/)で紹介しています。

## istio-proxyのサイドカーが不要なケース

### Job

Istioを有効にした場合Podに対してistio-proxyがsidecarとして挿入されます。
しかしながら、不要なケースも存在します。
1回だけ実行されるJobとして実行されるPodはJobが終了したするとPodのStatusがCompletedになりますが、istio-proxyは常駐するサーバーであるためJobがCompletedになりません。

そのため、JobはPod Templateに対して`sidecar.istio.io/inject: "false"`を指定することでSidecarを注入させないようにしています。

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: myjob
spec:
  template:
    metadata:
      annotations:
        sidecar.istio.io/inject: "false"
  # 省略
```

## BFFでサービスメッシュが有効だと何が良いか

最も嬉しいのは可観測性にあります。
BFFはその特性上、各マイクロサービスから情報をかき集め、場合によってはServer Side Rendering(SSR)を実施します。
最終的な結果はユーザーに届くため、一連の処理がユーザー体験に直接影響します。
ゆえに、明らかにレスポンスタイムが悪いマイクロサービスがある場合いくつかの行動を取ることができます。
特定のバージョンから悪化しているのであればロールバックを実行したり、
Client Side Rendering可能な情報であれば最初のHTMLを構成するためのクリティカルパスから除外したりすることが可能です。
少なくとも、継続的な監視は問題を明確にし、物事の優先度を合理的に決定することができます。
[負荷試験](/docs/08/loadtest/)や[モニタリング](/docs/08/monitoring/)の節で具体的なMetricsの可視化を紹介しています。
