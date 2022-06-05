---
title: RateLimitで負荷の上昇を防げないパターン
weight: 63
description: Rate Limitはリクエストをカウントします。したがってレスポンスの有無に関わらずリクエストを通過させる性質があるため、レスポンスタイムが長い場合はRate Limitを超えるリクエスト数が到達する可能性があります。
---

# RateLimitで負荷の上昇を防げないパターン

RateLimit を導入したからといって必ずしも負荷状態をバーストさせない状態を作れるわけではありません。
Global RateLimit として利用可能な[envoyproxy/ratelimit](https://github.com/envoyproxy/ratelimit)や、
Envoy 本体にある Local RateLimit、nginx の持つ RateLimit の実装を注意深く見ると、RateLimit の計算に利用するのは**リクエスト**のみです。
すなわち、レスポンスが返ったことを確認してカウントアップしたリクエスト数を下げるわけではないのです。
これはつまり、RateLimit よりも後方のサーバーがコネクションをキューイングした場合、RateLimit で指定したリクエスト数より多くのリクエストを処理することが可能になります。

## 発生メカニズム

簡略化したシーケンス図でまずは状況を説明します。図中には以下が登場します。

| 名称             | 役割                                                |
| :--------------- | :-------------------------------------------------- |
| User             | ブラウザなどのクライアント                          |
| Proxy            | Request に対する Rate Limit を適用                  |
| Server(Frontend) | BFF Server と置き換えても問題ない。図中の`Heavy Task`はServer Side Renderingと解釈するとよい。|
| Server(Backend)  | Server(Frontend)が少なくとも1つ以上はクリティカルに依存するサーバー |

![RateLimitが有効に使えないシーケンス図](../unless-ratelimit-sequence.svg)

**RateLimitが効いているにも関わらずServer(Frontend)のCPU使用率が上昇する流れ**

1. 何らかの理由によって`Server(Backend)`のレスポンスが遅くなる場合が発生
2. このとき、`Server(Frontend)`からのリクエストは設定したtimeoutまでコネクションを維持し続ける
3. RateLimitはRequestに対してのみ有効なため、Limitが効かない間は`Server(Frontend)`にリクエストを送信する
4. `Server(Backend)`のレスポンスタイムが正常に戻ると図中の4のResponseが発生する
5. すると、`Server(Frontend)`にキューイングされたリクエスト`Heavy Task`が定常よりも多く実行される
6. その結果、`Server(Frontend)`のCPU使用率が上昇する

### 問題点と対策

基本的にどのマイクロサービスも、連携しているマイクロサービスにSLA(Service Level Agreements)を満たせない可能性がある前提で振る舞いを決める必要があります。

**問題点**

今回のケースだと、`Server(Backend)`のレスポンスが伸びた場合、`Server(Frontend)`がリクエストをキューイングするところに問題点があります。
`Server(Frontend)`がレスポンスを返すために必要な情報を集めるために**長めに**タイムアウトを取っている場合、障害時にこのタイムアウト分だけコネクションが維持されることを忘れてはいけません。

**対策**

アプリケーションレベルの対応だと適切なタイムアウト設定や、そもそも高負荷になりうる処理がバーストしないように処理を組み替えるなどの対応が必要になってきます。
とはいえ、そこまで工数をかけられない場合はコネクション数を絞ったり、istio(envoy)のサーキットブレーカーなどの機能を有効にして、問題が波及しないように布石を打つ必要があります。

* [Circuit breakers — envoy documentation](https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/cluster/v3/circuit_breaker.proto.html)
* [Istio / Circuit Breaking](https://istio.io/latest/docs/tasks/traffic-management/circuit-breaking/)
