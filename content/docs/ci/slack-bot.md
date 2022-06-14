---
title: Slack Botによる自動化
weight: 43
description: Manifestの管理をSlack上での対話的なインターフェースで管理できる状態を構築しました。これにより、アプリケーション開発者がKubernetesを意識せずにスムーズに更新できる状態を実現しています。
---

# Slack Botによる自動化

Argo CDによるGitOpsの実現は同時にGitOpsを開発者に強制します。
すなわち、バージョンアップのためのcommitを実施し、Pull Requestを投げ、マージする必要があります。
更新頻度の多いアプリケーションを抱えた場合、この作業が非常に長く開発者の体験を悪くします。

そこで、Slack Botサーバーを作成しSlackにメッセージを入力することで手続き的なタスクをサーバー側に実施するようにしました。

## バージョンアップのシーケンス図

シーケンス図を使って紹介します。
バージョンアップの手順はSlack上でBotに対して次のようなコマンドを投げることから始まります。

```bash
# server-aをバージョン2.0.0に変更する
@bot update version:2.0.0 app:servive-a
```

これを受け取ったbotサーバーは、メッセージの入力者を判別したり、コマンド(`update version`)をパースしたりします。コマンドに応じてGitHub APIをCallし、[JSONで記述されたファイル](../../manifest/kubernetes-manifest-generator-architecture)(User Config)を書き換え、commitします。
その後Pull Requestを作成して、結果をユーザーに返します。

作成されたPull RequestをさらにSlackからマージします。

```bash
@bot merge pr:123
```

これをシーケンス図で書き起こすと次のようになります。

![ユーザーがSlackでメッセージを入力した際のシーケンス](../slack-bot-sequence-1.svg)

基本的な操作はすべてSlack上から実施が可能で、開発者がバージョンアップのためにリポジトリをCloneして環境構築する必要はありません。

## 既存のアプリケーションのCIとKubernetes Manifestのリポジトリの連携

Slack Botによって自動化されたKubernetesのManifestリポジトリは既存のリリースフローとも結合が容易になります。

例えば、アプリケーションにバージョンアップのCIタスクがあった場合、次のバージョン情報をSlackのWebhookを利用して先程と同じようにメッセージをBotに対して送るだけで結合できます。

```bash
# 擬似コード
message="{\"text\":\"@bot update version:${nextVersion} app:service-a\"}"
curl -X POST -H 'Content-type: application/json' --data $message https://hooks.slack.com/services/{your_id}
```

大抵のサーバーは`curl`かそれに類するHTTP Clientを用意できるため、たった2行挿入するだけでデプロイの簡略化ができます。

![アプリケーションのCIとKubernetesのManifestリポジトリの連携](../slack-bot-sequence-2.svg)

## Slack Botによってデプロイ作業を最小工数で終わらせる

バージョンアップのコマンドを紹介しましたが、他にも10個程度のコマンドがあります。

* リリース準備用のコマンド
* 最新のリリース情報の取得
* 次に投入される予定のバージョン情報の取得（差分）
* リリース用のチケット作成
* リリースノート更新

など、リリースに関する一連の情報や作業が細かくできるようになっています。
特に、差分情報やリリースノートの作成などを自動で実施しているためリリースの影響範囲が単純明快になるため確認コストが最小限になっています。

また、Slackのメッセージ経由で実施しているためBotサーバーが失敗した場合でも何がやりたかったのか証跡がSlack上に残ります。
再実行を実施するのももう一度メッセージをコピー&ペーストするだけの作業になります。


