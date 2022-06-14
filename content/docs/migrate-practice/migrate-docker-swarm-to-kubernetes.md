---
title: 通信経路の切り替え
weight: 91
description: KubernetesにDocker Swarmから通信経路を切り替えるにあたり実施した作業についてPhaseを分けて実施しました。
---

# 通信経路の切り替え

移行前の状態（Phase 1）から移行後の状態（Phase 2）までのステップは次のような経路で実施しました。

![Kubernetesでのネットワーク](../migrate-network.svg)

| Phase   | 経路                                                |
| :------ | :-------------------------------------------------- |
| Phase 1 | Apache → nginx → Container                        |
| Phase 2 | Apache → istio-ingressgateway → App(Docker Swarm) |
| Phase 3 | Apache → istio-ingressgateway → App(Kubernetes)   |

Apache による経路変更はパス単位（URI 単位）で実施できるため、流量が明らかに少ないパスを管理するマイクロサービスから移行を実施しました。

## 移行の流れ

移行時の細かい手順は次のようになります。

1. ApacheのBalancerMemberを利用してからPhase 1からPhase 2に切り替え
2. istio-ingressgatewayとKubernetes内のネットワーク系の状態を確認
   - 負荷試験の結果と照らし合わせて Gatewayのリソース使用量などを見る
3. Phase 3への切り替え前に、Virtual Serviceで特定のHeaderかQuery Parameterを利用して移行後のPodに対してアクセス。
4. Kubernetes内への疎通も確認できた後、istio-ingressgatewayのTraffic Weightを完全に切り替える

rps がそこまで高くない BFF はこの手順を繰り返すことで移行を淡々とすすめることができました。
高rpsのBFFサーバーはこの手順でやるにはリスクが高いので、トラフィックのミラーリングを実施してGatewayと Kubernetes クラスター全体の状態を確認していきます。
[アクセスログ](../../service-mesh/access-log)で紹介したようにPodにログ出力のための`nginx`が含まれるため、二重計上されないために`NodePort`を`istio-proxy`に向けたものをミラーリングのためのポートとして提供しています。
nginxのミラーリングによって高rpsの時間変化がDataDogに蓄積され、そこから[対応表](../../scalability/horizontal-pod-autoscaler/#リソースの値をどうやって決めるか)を用いてリソースの逆算を実施し、移行フェーズへステップを進めることができました。

[![リクエストのミラーリング概略図](../../performance/mirroring.svg)](../../performance/load-test/#proxyからリクエストをmirroringする)

## ロールバック設計

Phase 1, 2, 3 で移行ステップが区切られているのはロールバックのためです。
Istio の Virtual ServiceやGatewayに指定するパラメーターはAllow List形式であるため、明示的に指定しなければ疎通が取れません（全部通す設定も可能ではある）。
ゆえにアプリケーション側で必要なURIが開放されていない場合などにエラーが発生するため、ロールバックする可能性が十分にありました。
即時性を考えた結果、Phase1と2の状態を用意することで影響範囲に応じて即ロールバックできる状態にすることで落ち着きました。

結果は何度か Phase 1、2の状態に戻すことはありました。ただ、これによって得られたものは、
Manifestにアプリケーションのルーティングの仕様が明示的に記述されるようになり、忘却されにくい状態になりました。

## スケジュールの振り返り

| 時期    | 内容                                    |
| :------ | :-------------------------------------- |
| 2021/07 | Kubernetesの移行作業着手               |
| 2021/12 | Production環境でのKubernetes移行実施 |
| 2022/03 | Production環境での移行作業完了         |

この間、Kubernetes 自体や Argo 系のアプリケーションの更新も実施ししています。

| リリース時期 | リリースされたもの                                                                    |
| :----------- | :------------------------------------------------------------------------------------ |
| 2021/04/09   | [Kubernetes v1.21.0](https://github.com/kubernetes/kubernetes/releases/tag/v1.21.0)   |
| 2021/08/05   | [Kubernetes v1.22.0](https://github.com/kubernetes/kubernetes/releases/tag/v1.22.0)   |
| 2021/08/20   | [Argo CD v2.1.0](https://github.com/argoproj/argo-cd/releases/tag/v2.1.0)             |
| 2021/10/13   | [Argo Rollouts v1.1.0](https://github.com/argoproj/argo-rollouts/releases/tag/v1.1.0) |
| 2021/12/08   | [Kubernetes v1.23.0](https://github.com/kubernetes/kubernetes/releases/tag/v1.23.0)   |
| 2021/12/15   | [Argo CD v2.2.0](https://github.com/argoproj/argo-cd/releases/tag/v2.2.0)             |
| 2022/03/06   | [Argo CD v2.3.0](https://github.com/argoproj/argo-cd/releases/tag/v2.3.0)             |
| 2022/03/22   | [Argo Rollouts v1.2.0](https://github.com/argoproj/argo-rollouts/releases/tag/v1.2.0) |

※ minor バージョンは省略

## 移行中・移行後の運用

移行期間中、ArgoCDのGitOpsに則り、Manifestを管理するPull Requestを担当者が出す方式を取っていました。
しかしながら、高頻度で更新されるアプリケーションはこれが手間であるため、Slackからリリースに必要な準備一式が整うように調整しました。

Docker Swarmからのデプロイ手順はSlack上でコマンドを打つことで準備ができるようになり、
Kubernetesどころかリポジトリそのものを意識することが減りました。より詳細は[Slack Botによる自動化](../../ci/slack-bot)に書いています。

## まとめ

仕事は段取り八分とよくいったもので、移行に要した時間のほとんどが検証作業に費やされています。
Kubernetesに加え、サービスメッシュの導入によってObservabilityが向上し、リアルタイムで多くの情報が得られました。
移行期間中もリソース消費の予測がかなり簡単にでき、定量的に決定できたことは今後もデプロイを確実かつスムーズにするのに大いに役に立つと考えられます。
