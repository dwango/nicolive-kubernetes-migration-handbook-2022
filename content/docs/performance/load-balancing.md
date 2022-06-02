---
title: 負荷分散
weight: 83
---

# 負荷対策

## nodeSelector

[Node](https://kubernetes.io/ja/docs/concepts/architecture/nodes/)はPodが配置されるVMや物理マシンですが、
配置されるPodの処理内容によって使用されるリソースが大きく変わることがあります。
具体的にはIngress Gatewayはクラスター内外のトラフィックを集中的に処理することが事前にわかっています。
また、Ingress Gatewayがなければアプリケーションにアクセスできないため、必ずリソースが枯渇しない状態にする必要があります。
そのため、Gatewayとしての役割以外を持つPodと別のNodeに配置されるようにすることで、Podが安定して稼働できるリソースの確保を実現します。

KubernetesはNodeに対してラベルを付与し、PodにnodeSelectorを付与することで指定のNodeに対してPodを配置することができます。
Nodeに付与されているlabelは以下のコマンドで確認することができます。

```bash
$ kubectl get nodes --show-labels
# 簡単のため表示を省略
gateway01   Ready    <none>        1d    v1.21.12   node-role=gateway
gateway02   Ready    <none>        1d    v1.21.12   node-role=gateway
worker01    Ready    <none>        1d    v1.21.12   node-role=worker
worker02    Ready    <none>        1d    v1.21.12   node-role=worker
```

この場合、`worker`に対してPodを配置したい場合は次のように記述することができます。

```yaml {linenos=true,hl_lines=["10-11"]}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  namespace: demo
spec:
  template:
    # 中略
    spec:
      nodeSelector:
        node-role: worker
```

* [Node上へのPodのスケジューリング | Kubernetes](https://kubernetes.io/ja/docs/concepts/scheduling-eviction/assign-pod-node/)

## PodAntiAffinity

Podのスケジューリングはデフォルトのまま使用すると、Nodeに対する配置は明示的にコントロールされません。
つまり、あるアプリケーションを搭載したPodがNodeに偏らないようにしたいが、偏ってしまう（逆も然り）など発生します。
特にBFFサーバーはステートレスなサーバーであるため、分散配置されている方が望ましいでしょう。

Kubernetesでは`podAffinity`(podを条件に応じて集約)または`podAntiAffinity`(podを条件に応じて分散)を指定することでPodのスケジューリングをコントロールすることができます。
例えば、「`app.kubernetes.io/name=myapp`というラベルを持つPodが、**なるべく**同じNodeに配置されない」スケジューリング設定は次のように表現できます。

```yaml {linenos=true,hl_lines=[8, "32-35"]}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: demo
  labels:
    app: myapp
    app.kubernetes.io/name: myapp
spec:
  template:
    spec:
      affinity:
        # ポッド間のスケジューリングルール
        # 以下の条件に合致する場所に配置しないポリシー
        podAntiAffinity: # 逆は podAntiAffinity
          # 優先的に考慮されるスケジューリングポリシー
          preferredDuringSchedulingIgnoredDuringExecution:
            - # 優先度の重み付け（1 - 100の間で定義）
              # Nodeごとにweightを加算しScoreを算出し、
              # 最も高いスコアを獲得したNodeに対してPodが配置される
              weight: 1
              # app.kubernetes.io/name = "myapp" のラベルを持つPod
              podAffinityTerm:
                # Nodeをフィルタリングするためのキー。
                # この空間内のNodeに対するPod間のSelectorでAffinityのScoreが計算される
                # kubernetes.io/hostnameは各Nodeに付与される識別子として利用できる
                # (Nodeのフィルタリング条件として偏りがないキー)
                topologyKey: kubernetes.io/hostname
                labelSelector:
                  # app.kubernetes.io/name = "myapp" にマッチするPodを集計対象とする
                  matchExpressions:
                    - key: app.kubernetes.io/name
                      operator: In
                      values:
                        - myapp
```

`preferredDuringSchedulingIgnoredDuringExecution`は`podAffinityTerm`で指定された`labelSelector`に該当するPodを`topologyKey`ごとに`weight`を加算してスコアを算出します。
`podAntiAffinity`で利用されるスコアになるため、スコアが高くなるほどPodはスコアの高いNodeに対してなるべく**配置されない**ようになります。
（`podAntiAffinity`はスコアの符号がマイナスで、`podAffinity`はスコアの符号がプラスと思えばわかりやすい。）

また、ここでは`labelSelector`で使う`key`や`topologyKey`はWell-Known Labelsを利用しています。

* [Node上へのPodのスケジューリング | Kubernetes](https://kubernetes.io/ja/docs/concepts/scheduling-eviction/assign-pod-node/)
* [Well-Known Labels, Annotations and Taints | Kubernetes](https://kubernetes.io/docs/reference/labels-annotations-taints/)
