---
title: 移行前・移行中・移行後のネットワーク設計
weight: 21
---

# 移行前・移行中・移行後のネットワーク設計

## 移行前のネットワーク構成

![移行前のネットワーク構成](../docker-swarm-network.svg)

移行前のDocker Swarmのネットワーク構成図のようになっています。

Trafficを最上位のロードバランサーで受けた後、Apacheやnginx、OpenRestyといった複数のL7ロードバランサーで受けた後に
Docker Swarmのクラスターに到達し、コンテナネットワークに接続されてWebアプリケーションがレスポンスを返す様になっています。

## 移行中のネットワーク構成

![移行中のネットワーク構成](../migrate-network.svg)

図はDocker SwarmからKubernetesに移行するにあたってネットワークのネットワーク構成になります。
基本的な移行方法としてはクラスター外のロードバランサーから新旧の環境に`PATH`単位でしていくことで段階的に移行することが可能です。

今回Apacheをそのハンドルに選んだ理由は[後述](#apacheを移行時のロードバランサーとして選定した理由)しています。

## 移行後のネットワーク構成

![移行とのネットワーク構成](../kubernetes-network.svg)

Kubernetes上でのネットワーク構成は図のようになりました。
ApacheによるLoad Balanceは移行前のDocker Swarmと同じですが、全てのアプリケーションは一度全てIstioのIngress Gatewayを経由するようになりました。

また、Rate Limitなどnginxで実施していたシステムの防衛処理はKubernetesクラスター全体に対するGlobal Rate LimitとPod単位のLocal Rate Limitに機能を分割しました。これらの詳細は別のページで紹介しています。

* [Rate Limitに関して](/docs/06/)
* [Istio Ingress Gatewayに関して](/docs/05/ingress-gateway/)
* [アクセスログに関して](/docs/05/ingress-gateway/)

## Apacheを移行時のロードバランサーとして選定した理由

1. ApacheというL7ロードバランサーはRequest / Response Headerなどの処理をすでに抱えており、短期間で移植することは困難であることが想定されました。
2. ApacheよりもDown Stream側にあるロードバランサーをチームの権限でコントロールすることはできないため変更のリードタイムが長くなることが想定されました。
3. ApacheではなくnginxやHAProxyだったら移植できたかというとそういう問題でもなく、直接KubernetesクラスタでTrafficを受けたときにKubernetes自体やIstio Ingress GatewayがTrafficの負荷に耐えられるか、信頼できる負荷試験の結果が存在しないため、旧環境に切り戻すリスクが高いと判断しました。

すなわち、運用実績とオペレーションの容易さからApacheで移行することが移行時に取り得る選択肢として最良と判断しました。

※ 結果は言わずもがなですが、書いてあるとおりスケジュール通りに移行を完遂させています。
