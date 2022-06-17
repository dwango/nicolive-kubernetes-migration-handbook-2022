---
title: 水平スケール
weight: 71
description: Kubernetesはリソースの使用状況に応じてPodをスケールアウトする手段を持っています。ここでは各種パラメーターを決めるに必要な情報を整理します。
---

# 水平スケール

Kubernetesは監視しているCPU使用率などのMetricsをもとにPodの数を自動的にスケーリングさせる機構、Horizontal Pod Autoscalingを持っています。
[metrics server](https://github.com/kubernetes-sigs/metrics-server)を利用するとCPU使用率やMemory使用量をベースに水平スケールを支援してくれます。

## Horizontal Pod Autoscaler

Horizontal Pod Autoscaler（以下HPA）は観測されたMetricsを元に指定のPodのreplicasを増減させる仕組みです。
Manifestの書き方はシンプルで、`autoscaling/v2beta2`で記述すると次のようになります。

```yaml
apiVersion: autoscaling/v2beta2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp
spec:
  minReplicas: 10
  maxReplicas: 20
  scaleTargetRef:
    kind: Deployment # Argo Rolloutsを使用している場合は Rollout を指定する
    apiVersion: argoproj.io/v1alpha1
    name: myapp
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80
```

これは探索されたPodのCPU使用率が80%を超えるようになった場合に、それを下回るようにPod数を増加させます。
逆に下回った場合は`minReplicas`まで戻るように働きます。

注意点として、

{{< katex display >}}
\text{CPU使用率/1Pod} = \frac{\text{Podを構成するコンテナ全体の使用中のコア数の合計}}{\text{各コンテナのlimits.cpuの合計}}
{{< /katex >}}

で算出されます。つまり、Sidecarとして挿入されるistio-proxyのResourceも考慮した上でHPAの閾値を考慮する必要があります。実際に使用されているResourceは以下のCLIコマンドで確認できます。

```bash
kubectl top pod myapp-[podid]
kubectl top pod --containers myapp-[podid]
```

* [Support for resource metrics](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/#support-for-resource-metrics)

これらを踏まえた上でHPAの設計をします。

## リソースの値をどうやって決めるか

BFFを含むPodの大きな特徴として、

1. Stateless
2. 他マイクロサービスからデータを収集する
3. Server Side Renderingを実施することもある

という点が上げられます。つまり、リクエストがBFFに滞在する時間が長くなることを基本的には想定はしていません。
このことから単純にRequest Per Sec(RPS)に比例してCPU使用率が上昇することが予測できるため次のような比例グラフが書けます。

![HPAとRateLimitの関係](../hpa-schema.svg)

ただし、Podの性能限界が存在するため無尽蔵に1つのPodのRPSが伸びるわけではありません。
途中で比例グラフが破綻するか、正常レスポンスを返せなくなるところがあります。
図中の`Pod Performance Limit`はこれを示しています。

また、([Global](../../rate-limit/global-ratelimit) / [Local](../../rate-limit/local-ratelimit)) Rate Limitで流量制御はPodが`Pod Performance Limit`のrpsよりも低く、
HPAが発動するRPSよりも大きく指定する必要があります。

これらの値を決定するためには[負荷試験](../../performance/load-test)を実施することで値を予測することが可能になります。

## バースト性のあるリクエストをどうやって耐えるか

予測可能なバーストリクエスト数は事前にスケールアウトしておくことで必要なスループットを確保することができます。
ニコニコ生放送のように人気番組が発生するようなケースはHPA External Metricsを利用して動的にスケールアウトをスケジューリングする方法が考えられます（[参考文献1, 2](#参考文献)）。

しかしながら、実際には予測不能な負荷はどうするか考える必要があります。
結論から言えばPod数を単純に多くして、定常時のResourceのCPU Requestをその分小さくします（下限はあります）。
そして、サービスが担保する最大rpsをGlobal Rate Limitによって制限することでそれを超えるリクエストはステータスコード429を返すようにします。

つまり次のような計算式でrpsを最大にするためのreplicasと`resources.requests.cpu`を算出できます。

{{< katex display >}}
\text{replicas} \times \text{containers[].resources.requests.cpu} = \text{全体のrequests.cpu}
{{< /katex >}}
{{< katex display >}}
\text{replicas} \times \text{HPA Trigger rps} = \text{スケールアウトしない場合の全体のrps}
{{< /katex >}}
{{< katex display >}}
\text{スケールアウトしない最大のrps} = \frac{\text{全体のrequests.cpu (最大値)}}{\text{containers[].resources.requests.cpu (最小値)}} \times \text{HPA Trigger rps}
{{< /katex >}}

> **注意**
>
> - `containers[].resources.requests.cpu`は下げすぎるとPodが起動しないことがあるため、下限があります。 
> - `全体のrequests.cpu`はクラスターのリソース内でしか割り当てられないため、上限があります。

これでスケールアウトせずに処理可能なrpsの最大値を得ることができます。

また、Global RateLimitの値は次のどちらか小さい方の値を採用します。

1. BFFがスケールアウトせずに処理できるrps（前述）
2. BFFより後方のマイクロサービスが処理可能なrpsの最大値

これを超えるような場合は増資増強が必要になってきます。

## 水平スケール設計の今後

バースト耐性を持たせるためには大量のPodを常時配置しておく必要がありますが、やはりそれでは余剰リソースが出てしまうので、[Kubernetes HPA External Metrics](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/#autoscaling-on-metrics-not-related-to-kubernetes-objects)を利用したスケールアウトの柔軟なスケジューリングの構成も必要になってきます。
ただし、リソースはやはり有限であるため優先度の高いPodからスケールアウトするように[Pod Priority and Preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)も決めていく必要があります。これらの精度を上げていくには、Podを構成する個々のアプリケーションのパフォーマンスについてより詳しくなる必要があり、洗練された負荷試験が必要なことがわかります。

## 参考文献

1. [Kubernetes HPA External Metrics を利用した Scheduled-Scaling - スタディサプリ Product Team Blog](https://blog.studysapuri.jp/entry/2020/11/30/scheduled-scaling-with-hpa)
2. [Kubernetes HPA External Metrics の事例紹介 | メルカリエンジニアリング](https://engineering.mercari.com/blog/entry/20220218-cd149f6298/)
