---
title: Istio Ingress Gatewayの設定
weight: 53
---

# Istio Ingress Gatewayの設定

Ingress Gatewayクラスター外部に対してクラスター内部のServiceに対するルーティングを公開します([Ingressとは何か](https://kubernetes.io/ja/docs/concepts/services-networking/ingress/#ingressとは何か))。
IstioもIngress Gatewayを提供しており、L7のルーティング設定を記述することができます。

Istio Ingress Gatewayの設定を変更するためにはいくつかのComponentを定義する必要があり、代表的なのはドキュメント([Istio / Ingress Gateways](https://istio.io/latest/docs/tasks/traffic-management/ingress/ingress-control/))で紹介されている`Gateway`と`VirtualService`になります。
nginxやApacheのようにconfファイルを起動時に読み込む形式と違い、istioがEnvoyに対してAPI経由で設定変更を動的に変更することになります。
そのため、どのistio-proxy(GatewayもしくはSidecarとして機能しているEnvoy)に対して設定を適用させるか記述する必要があります。

ここでは、以下の図中のIstio Ingress Gatewayに対して設定を変更します。

![istio ingress gatewayの概略図](../istio-ingress-gateway.svg)

## `hosts`でルーティングを分ける

例えばPCとスマートフォン(SP)でルーティング先を分けたい場合があります。
これを実現するためにはまずは[Gateway](https://istio.io/latest/docs/reference/config/networking/gateway/)を宣言する必要があります。
ここではわかりやすいようにPCのルーティング先を`pc.example.com`、SPの行き先を`sp.example.com`として定義します。

**PC用Gateway**

```yaml {linenos=true,hl_lines=[16]}
apiVersion: networking.istio.io/v1alpha3
kind: Gateway
metadata:
  name: pc-example-com
  namespace: demo
spec:
  selector:
    app.kubernetes.io/name: istio-ingressgateway
    app.kubernetes.io/part-of: istio
  servers:
    - port:
        number: 33000
        name: http
        protocol: HTTP
      hosts:
        - pc.example.com
```

**SP用Gateway**

```yaml {linenos=true,hl_lines=[16]}
apiVersion: networking.istio.io/v1alpha3
kind: Gateway
metadata:
  name: sp-example-com
  namespace: demo
spec:
  selector:
    app.kubernetes.io/name: istio-ingressgateway
    app.kubernetes.io/part-of: istio
  servers:
    - port:
        number: 33000
        name: http
        protocol: HTTP
      hosts:
        - sp.example.com
```

このとき、`.metadata.namespace`と`.spec.selector`で設定を適用したいIstio IngressGatewayを絞り込みます。
仮にGatewayを定義しなかった場合、Istio IngressGatewayはリクエストを後方のマイクロサービスに疎通させません。
次に、このGatewayをVirtualServiceに対してバインドします。

**PC版Virtual Service**

```yaml {linenos=true,hl_lines=[8, 18]}
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: pc-route
  namespace: demo
spec:
  gateways:
    - pc-example-com
  hosts:
    - "*"
  http:
    - name: http-route
      match:
        - uri:
            prefix: /
      route:
        - destination:
            host: pc.demo.svc.cluster.local
            port:
              number: 80
          weight: 100
```

**SP版Virtual Service**

```yaml {linenos=true,hl_lines=[8, 18]}
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: sp-route
  namespace: demo
spec:
  gateways:
    - sp-example-com
  hosts:
    - "*"
  http:
    - name: http-route
      match:
        - uri:
            prefix: /
      route:
        - destination:
            host: sp.demo.svc.cluster.local
            port:
              number: 80
          weight: 100
```

Virtual Serviceは`.spec.gateways[]`に`Gateway`の`.metadata.name`(namespace内でユニーク)を指定することで、
同一`namespace`内のGatewayを特定してバインドしています。

語弊を恐れずにこれらのコンポーネントの流れを書くと次のようになります。

```
[host]pc.example.com:33000        # アクセス
  → [Gateway]pc-example-com       # hostsとPortの宣言
    → [VirtualService]pc-route    # Gatewayのバインド、PATHに対するServiceへルーティング
      → [Service]pc.demo.svc.cluster.local # Podに対するルーティング
```

以上でhostsに対するルーティングを実現することができます。

また、これらの操作により、同じnamespace内でpcとspで別々のIngress Gatewayに分離したい要求が発生した場合はIngress Gatewayが増えた場合は
`Gateway`の`.metadata.selector`を調整することで対応することができます。

## HeaderやQueryParameterでルーティングする

Virtual Serviceは`URI`やHeader、Query Parameterなどの情報をもとに、ルーティング先のServiceを変更することができます。
Argo Rolloutsはこの機能を利用してBlueGreenデプロイや、Canaryデプロイを実現しています。
デプロイの機能として利用するだけでなく例えば「Preview版の機能を特定のHeader情報を含む場合にのみ公開する」などを実現することが可能です。

例えば、Headerに`version: v2`が含まれる場合は、`.metadata.name=pc-v2`のServiceにルーティングする設定は次のように書くことができます。

```yaml {linenos=true,hl_lines=["16-18", 21, 30]}
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: include-preview-route
  namespace: demo
spec:
  gateways:
    - pc-example-com
  hosts:
    - "*"
  http:
    - name: http-preview
      match:
        - uri:
            prefix: /
          headers:  # queryParamsにすると ?preview=v2 でルーティングされる
            preview:
              version: v2
      route:
        - destination:
            host: pc-v2.demo.svc.cluster.local
            port:
              number: 80
    - name: http-common
      match:
        - uri:
            prefix: /
      route:
        - destination:
            host: pc.demo.svc.cluster.local
            port:
              number: 80
```

試験的に実現したい機能などを本番環境に投入したい場合などに役に立つことは間違いないでしょう。

VirtualServiceを記述する注意点として、`.spec.http[]`は条件の厳しいものが先にくるように記述する必要があります。
また、ルーティング先の`host`となるServiceが存在しない場合はManifestがApplyできないことがあります。
