---
title: Global RateLimit
weight: 61
---

# Global RateLimit

Global Rate LimitはIngress Gatewayより後方側にいるPodに対するリクエストの流量制限を実施します。
すなわち、Kubernetesクラスターまではリクエストは到達します。
[envoyproxy/ratelimit](https://github.com/envoyproxy/ratelimit)はこれを実現するためのリファレンス実装で、外部サービスとして後付で導入することが可能です。

Trafficがingress gatewayに到達した後の大雑把な流れは次のとおりです。

1. `rate_limit_service`で指定されたマイクロサービスにたいしてgrpcで問い合わせをします。
2. `envoyratelimit`は`redis`（`memcache`も利用可）に格納したDescriptorに対するリクエスト数の計算を実施します。
   * [ratelimit.go#L164](https://github.com/envoyproxy/ratelimit/blob/main/src/service/ratelimit.go#L164)
   * [fixed_cache_impl.go#L39-L128](https://github.com/envoyproxy/ratelimit/blob/main/src/redis/fixed_cache_impl.go#L39-L128)
3. 結果をingress gatewayに対して[RateLimitResponse](https://pkg.go.dev/github.com/envoyproxy/go-control-plane@v0.10.1/envoy/service/ratelimit/v3?utm_source=gopls#RateLimitResponse)に乗せて返却
4. ingress gatewayはレスポンスを受けて429を返すかどうか決定する。

![Global RateLimitの概略](../global-ratelimit.svg)

## Global Ratelimitの設定

`envoyproxy/ratelimit`を利用するには2つの設定が必要です。

1. Descriptorの設置 
2. Descriptorに対するRate Limitの定義

DescriptorはEnvoy（istio-proxy）に対して定義することが可能で、Gatewayとして機能しているistio-proxyだけでなく、Sidecarとして搭載されているistio-proxyに対しても定義することが可能です。

Descriptorは[Action](https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/route/v3/route_components.proto#config-route-v3-ratelimit-action)によって条件が定義することができ、これをリファレンス実装されたratelimitのマイクロサービスで使用することにより、特定のPATHやheaderに対してratelimitを適用することができます。

具体的な例を示しましょう。

### `:path`単位でRate Limitをかける

例えば、`/`というパスに対してRate Limitを作りたい場合、まずDescriptorをGatewayのistio-proxyに対して作る必要があります。

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: ratelimit-actions
spec:
  workloadSelector:
    labels:
      app: istio-ingressgateway
  configPatches:
    - applyTo: VIRTUAL_HOST
      match:
        context: GATEWAY
        routeConfiguration:
          vhost:
            name: ""
            route:
              action: ANY
      patch:
        operation: MERGE
        value:
          rate_limits:
            - actions:
                - request_headers:
                    # HTTPの場合Request Headerの`:path`にURIが格納されている
                    header_name: ":path"
                    # "PATH"という名前でDescriptorを作成する
                    descriptor_key: PATH
```

※ これ以降、`rate_limits`より上層の定義は省略します。

この`PATH`に対してenvoyproyx/ratelimitによって`10 rpm (request / minutes)`の制限を加える定義は次のようになります。

```yaml
descriptors:
  - key: PATH # actionsに定義したdescriptor_key
    value: /  # Descriptorが取得するValue、つまり今回の場合はURI
    rate_limit:
      unit: minute
      requests_per_unit: 10
```

**正規表現でDescriptorを絞り込む**

実践的にはより複雑なURIに対してRate Limitを書けることになるます。
ニコニコ生放送では`/watch/lv12345...`といった具合のURIに対して制限を適用する必要があります。

この場合Descriptorの定義は正規表現を以下のように記述することで表現することができます。

```yaml
rate_limits:
  - actions:
      - header_value_match:
          descriptor_value: watch
          headers:
            - name: ":path"
              safe_regex_match:
                google_re2: {}
                regex: /watch/(lv\d+)
```

Rate Limitは前回と同様にDescriptorに対して記述するだけで定義できます。

```yaml
descriptors:
  - key: header_match
    value: watch
    rate_limit:
      unit: second
      requests_per_unit: 9999999
```

## istio-proxyとRate Limitのマイクロサービスとの連携

次のようなEnvoyFilterをIngress Gatewayに対して適用しています。

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: ratelimit-gateway
spec:
  workloadSelector:
    labels:
      app: istio-ingressgateway
  configPatches:
    - applyTo: HTTP_FILTER
      match:
        context: GATEWAY
        listener:
          filterChain:
            filter:
              name: envoy.filters.network.http_connection_manager
              subFilter:
                name: envoy.filters.http.router
      patch:
        operation: INSERT_BEFORE
        value:
          name: envoy.filters.http.ratelimit
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.http.ratelimit.v3.RateLimit
            domain: nicolive
            # Envoy Ratelimitとの疎通が失敗した場合など、
            # トラフィックをUpstreamに流れるようにする
            failure_mode_deny: true
            timeout: 10s
            rate_limit_service:
              grpc_service:
                envoy_grpc:
                  # Istioのドキュメントとここが異なる
                  cluster_name: outbound|8081||ratelimit.mynamespace.svc.cluster.local
                  authority: ratelimit.mynamespace.svc.cluster.local
              transport_api_version: V3
```

[Istioのドキュメント](https://istio.io/latest/docs/tasks/policy-enforcement/rate-limit/)をそのまま流用した場合、
EnvoyのCluster定義を追加する記述がありますが、これはKubernetesのServiceを以下のように定義するとEDS（Endpoint Discovery Service）によって
利用可能な`cluster_name: outbound|8081||ratelimit.mynamespace.svc.cluster.local`が自動的に定義されます。

これにより、cluster名を`STATIC_DNS`（L4）からEDS（L7）に変更することができ、Rate LimitのPodの更新時に瞬断が発生しなくなります。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ratelimit
spec:
  type: ClusterIP
  selector:
    app: ratelimit
    app.kubernetes.io/name: ratelimit
  ports:
    - name: http-ratelimit-svc
      port: 8080
      targetPort: 8080
      protocol: TCP
    - name: grpc-ratelimit-svc
      port: 8081
      targetPort: 8081
      protocol: TCP
    - name: http-debug-ratelimit-svc
      port: 6070
      targetPort: 6070
      protocol: TCP
```


また、RateLimitとの疎通は`failure_mode_deny: false`を指定しています。
Ingress Gatewayに対するアクセスはすべてが一度Rate LimitのPodを経由します。
デフォルトの場合（`failure_mode_deny: true`）、何らかの理由でRate LimitのPodとの疎通が取れなくなった場合にIngress Gatewayからユーザーに対して503エラーが返るようになります。
この影響はサービス全体に波及するためこのフラグは`false`にしています。

仮にGlobal RateLimitが機能しなくなった場合、リクエストはそのままUpstream側のマイクロサービスまで貫通しますが、
異常なリクエストに対しては次に紹介するLocal Ratelimitによって多重の防御が用意されています。


