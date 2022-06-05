---
title: Local RateLimit
weight: 62
description: PodのサイドカーでRate Limitを実施することにより、アプリケーションコンテナに対する負荷の上昇を制限します。またスケールアウトした場合でも同様の効果を得ることができます。
---

# Local RateLimit

**Global RateLimitとの違い**

Local RateLimitと[Global RateLimit](/docs/06/global-ratelimit/)の違いは守るスコープの違いにあります。
Global RateLimitはUpstream側のシステムを守るため、RateLimitのマイクロサービス間でリクエスト数を共有するためのストア(redisなど)を外側に持っています。
それに対し、Local RateLimitはRateLimitを提供するProxyだけがリクエスト数を保持でいればよいためインメモリーで実装することができます。

**Kubernetes上におけるLocal RateLimitの設置候補**

Local RateLimitを実施する候補は2つあります。

1. istio-proxy（Envoy）のLocal Ratelimit機能を利用する
2. nginxをistio-proxyとAppの間に立たせ、nginxのRateLimitを利用する

![Local RateLimitの概略](../local-ratelimit.svg)

## envoy と nginx の Rate Limit アルゴリズムの違い

envoy と nginx では Rate Limit のアルゴリズムが異なります。
ゆえに、バースト性のあるトラフィックに対する制限が異なり、どちらからの乗り換えに対しても検証なしで乗り換えすることはできません。

| Proxy Server | Rate Limit Algorithm                                                                                                |
| :----------- | :------------------------------------------------------------------------------------------------------------------ |
| nginx        | [Leaky Bucket](https://www.nginx.com/blog/rate-limiting-nginx/)                                                     |
| envoy        | [Token Bucket](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/local_rate_limit_filter) |

## envoyとnginxの設定例

例えば`myapp`というアプリケーションに対して`10 rps`の Rate Limit の制限をかけ、バースト時のリクエストは`50 rps`まで受け付けるようにした場合次のように記述できます。

### EnvoyののLocal Rate Limit設定例

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: filter-local-ratelimit-myapp
spec:
  workloadSelector:
    labels:
      app: myapp
  configPatches:
    - applyTo: HTTP_FILTER
      match:
        context: SIDECAR_INBOUND
        listener:
          filterChain:
            filter:
              name: envoy.filters.network.http_connection_manager
      patch:
        operation: INSERT_BEFORE
            value:
              stat_prefix: http_local_rate_limiter
              # Local Ratelimitのパラメーター
              token_bucket:
                max_tokens: 50
                tokens_per_fill: 10
                fill_interval: 1s
              filter_enabled:
                runtime_key: local_rate_limit_enabled
                default_value:
                  numerator: 100
                  denominator: HUNDRED
              filter_enforced:
                runtime_key: local_rate_limit_enforced
                default_value:
                  numerator: 100
                  denominator: HUNDRED
```

### nginxのRate Limit設定例

```conf

http {
  limit_req_zone myapp_zone zone=myapp_zone:1m rate=10r/s;
  server {
    location /myapp {
      limit_req zone=myapp_zone burst=50 delay=10;
      limit_req_status 429;
      # 省略 ...
    }
  }
}
```

## どちらを選ぶか

これらを選択するにあたりバースト時の挙動を確認する必要があります。
例えば、前述の設定で 1 つの Pod に対して 70rps 来た場合、envoy と nginx は次の挙動をします。

| proxy | 挙動                                                                                                                                                                                                           |
| :---- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| envoy | `max_tokens: 50`まで消費し、50rps が App まで到達する。`fill_interval`が 10 で指定されているためそれ以降のリクエストは token が回復するまで`10rps`を維持する。`max_tokens: 50`から溢れた 20rps は 429 を返す。 |
| nginx | `burst=50`で指定したリクエスト数まで一度 nginx で受け付け、`delay=10`で指定した 10 req 分だけ App まで到達する。残りの 40req はキューイングされて FIFO で処理される。`burst=50`から溢れた 20rps は 429 を返す。 |

つまり、envoy で Local RateLimit を敷いた場合は`max_tokens`で指定したリクエストはたしかに受け付けますが、それをキューせずに Upstream の App にリクエストを流します。この流量をアプリケーション側が処理することが可能であれば`envoy`の Rate Limit を採用することができます。これが逆に処理できない場合は App のコンテナが処理しきれずに 503 を返します。

したがって、バースト耐性を獲得しつつ、移行というスケジュールが決まった範疇で選択できるのは`nginx`を利用した Local Rate Limit になります。istio-proxyに加えてnginxもproxyとして挟まりスループットが若干悪くなりますが、BFFを構成するサーバーの応答速度と比較して十分に小さいため許容することにしました。

## 今後どうするか

Podを構成する要素としてProxyが2段構えになっているのは多少格好は悪いですが、うまく機能しています。
ただし、後述しますが、envoyやnginxのRateLimitでは[負荷の上昇を防げないパターン問題点](/docs/06/ratelimit-is-unless/)もあります。
アクセス傾向やPodのMetricsなどを総合的に鑑みてRate Limitの構成と設定値を決めていく必要があります。
