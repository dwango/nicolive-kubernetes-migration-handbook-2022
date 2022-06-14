---
title: Argo Rolloutsの利用
weight: 42
description: Argo RolloutsとIstioを利用したCanary Deployを構築しました。
---

# Argo Rolloutsの導入

## Argo Rolloutsとは

Argo RolloutsはKubernetes上にPodをデプロイする方法の選択肢を増やしてくれます。
Blue/Greenデプロイ、Canaryデプロイ、Progressive Deliveryなど。

とくにTraffic Managementを利用したデプロイ方法は非常に魅力的で、利用しない理由は見当たりませんでした。
ちょうどArgo Rolloutsがv1系が利用可能な状態で、移行時の検証と同時に必要な機能が使えることを確認できたため導入しました。

* 2021/05 [v1.0.0](https://github.com/argoproj/argo-rollouts/releases/tag/v1.0.0)
* 2021/10 [v1.1.0](https://github.com/argoproj/argo-rollouts/releases/tag/v1.1.0)
* 2022/03 [v1.2.0](https://github.com/argoproj/argo-rollouts/releases/tag/v1.2.0)

## Istio + Argo Rollouts

Istio自体はすでに利用可能な状態にあったため、Traffic Managementを実施するLoadBalancerはIstioを利用しています。

* [Istio - Traffic Management](https://argoproj.github.io/argo-rollouts/features/traffic-management/istio/)

他と比較はできていませんが、IstioでTraffic Managementをすると、IstioのService Meshの恩恵をそのまま得られることができCanaryデプロイ時にTraffic Weightが変化していることが観測できるようになります。
なお、[Istio Ingress Gatewayの設定](../../service-mesh/traffic-management)でその他の機能についても紹介しています。

## Canary Deployを実施する

RolloutのManifestは`.spec.strategy`以外の部分はDeploymentと同じです。

```yml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-app
spec:
  strategy:
    canary:
      trafficRouting:
        istio:
          virtualService:
            name: my-app
            routes:
              - http-my-app-primary
      maxSurge: 33%
      canaryService: my-app-canary
      stableService: my-app-stable
      dynamicStableScale: true
      steps:
        - setCanaryScale:
            matchTrafficWeight: true
        - pause:
            duration: 60
        - setWeight: 34
        - setCanaryScale:
            matchTrafficWeight: true
        - pause:
            duration: 60
        - setWeight: 67
        - setCanaryScale:
            matchTrafficWeight: true
        - pause:
            duration: 60
        - setWeight: 100
```


特徴的なのは`canaryService`と`stableService`用に2つの`Service`定義が必要になるところです。
Rolloutsに定義されたServiceは

```
.spec.selector.rollouts-pod-template-hash: "HashValue"
```

がArgo Rolloutsによって付与されます。またPodの更新時にReplicaSetにも

```
.spec.selector.matchLabels.rollouts-pod-template-hash: "HashValue"
```

が指定され、Canary用のServiceとStable用のServiceのエンドポイントが区別されています。
あとはIstioのVirtual ServiceのTraffic Weightに対する変更がStep単位で記述することが可能です。

### 注意点

Argo RolloutsはDashboardでは`Promote Full`というボタンがあります。
これを利用した場合、stepを無視してPromotionの最終状態まで到達します。
つまり、トラフィックを受け付ける準備ができていないPodに対してもトラフィックが流れるため、使う場面を見極める必要があります。

* Argo Rollouts v1.2.0で確認

### Traffic Weightに応じたReplicasを指定する

```
.spec.strategy.canary.steps[].setCanaryScale.matchTrafficWeight = true
```

を指定することで、`.spec.replicas`を100%ととしたReplicasがTraffic Weightに比例してPodが配置されます。

また、`setCanaryScale.replicas`と併用して指定している場合は、CanaryのreplicasはRolloutsのmanifestで指定した値に必ずしもならず、Traffic Weightで算出されたCanaryのReplicasと手動で指定したReplicasのTrafficに耐えられるうち安全な方が優先されて指定されます。

* https://github.com/argoproj/argo-rollouts/blob/v1.2.0/utils/replicaset/canary.go#L331-L353


### Canary Deploy時トラフィックが流れていないPodを縮退させる

以下のフラグを有効にすることで実現できます。

```
.spec.strategy.canary.dynamicStableScale = true
```

これにより、replicasとTraffic Weightを同時にコントロール可能な状態になります。

## DataDogでのモニタリング例

あるマイクロサービスのPodに対するRequest Per Secをバージョンで分類して、
Rolloutsによる更新をモニタリングすると次のようにTrafficが変更されていることがわかります。

![更新時のRequest Per Secondsの変化](../rollouts-update-rps-metrics.png)

同様にCPUの使用率も確認すると、たしかにRolloutsで定義したStep通りにPodは増加し、
Trafficが流れなくなったPodは徐々に終了していることが確認できます。

![更新時のCPU使用率の変化](../rollouts-update-cpu-metrics.png)

## これから

Argo Rolloutsは**Progressive Delivery**を実現する方法を提供しており、DataDogとの連携も容易にできることがわかっています。

* https://argoproj.github.io/argo-rollouts/analysis/datadog/

これを実現するために、今現在は各種Metricsの集計とその信頼性の検証を進めています。
BFFのマイクロサービスの安定性を表すための定量的な指標を集計値として表せてはじめてこの機能を有効にできるため、
運用の実績値を蓄積し、集計し、不足しているMetricsを追加する作業を繰り返し行っています。
