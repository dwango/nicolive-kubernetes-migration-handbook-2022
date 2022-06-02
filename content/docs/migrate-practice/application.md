---
title: アプリケーションの移行
weight: 92
---

# アプリケーションの移行

Kubernetes移行にあたりBFFサーバーで調整した内容を紹介します。

## Graceful Shutdown

プロセス終了命令(`SIGTERM`)などのシグナルを受け取ったときに、サーバーに残っているリクエストがレスポンスを返し終わってからプロセスを終了する仕組みです。
これはKubernetesでなくても実装すべき内容で、安全に処理を終わらせるために必要です。

expressでの実装例は次のとおりです。

```ts
import * as express from "express";

const app = express();

const httpServer = app.listen(process.env.PORT || 80);

// SIGNALを受け取る
process.on("SIGTERM", () => {
  httpServer.close();
});
```

`process.on`でSIGNALを受け取ることができるため、そこでHTTP ServerをCloseするだけになります。
他にもWebSocket Serverを起動している場合もここでclose処理を実施すると安全に終了できます。


## 静的リソースのアップロード

静的リソースはAmazon S3にアップロードされたファイルをCDN(CloudFront)から配信する形式を取っています。
そのため、S3にアップロードする処理が必要で、移行前はJenkinsでこれを実行していました。

静的リソースはこれまでJenkinsのタスクによってアップロードしていましたが、KubernetesのJobとして移行しました。

具体的には、アプリケーションのCIによってリリース用のnpmパッケージが作成され、Private Registryにアップロードされたり、
ものによってはGitHubのRelease Assetsにアップロードされたりしています。

Kubernetes上のJobは

1. npm packageにリリースする静的リソースをダウンロードし、
1. 静的リソースのホスティングに本当に必要なファイルだけを抽出し、
1. S3にアップロード

という処理を実施しています。

![静的リソースのデプロイフロー](../static-resource-deploy.svg)

内部の処理は環境変数で処理できるように実装されており、npmパッケージとアップロード先のS3の保存先を選ぶことができます。
また、[Argo CDのSync Wave](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)と組み合わせて、
アプリケーションのDeploymentがApplyされるより前にこのJobを実行するように順序を決めることでクリティカルパスを形成することができます。
以下は静的リソースのアップロードJobの例です。

```yaml {linenos=table,hl_lines=[11,"26-38"]}
apiVersion: batch/v1
kind: Job
metadata:
  name: static-resource-upload-job-v1.0.0
  labels:
	app: static-resource-upload-job-v1.0.0
	version: 1.0.0
	app.kubernetes.io/name: static-resource-upload-job
	app.kubernetes.io/version: 1.0.0
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
spec:
  ttlSecondsAfterFinished: 86400 # 24時間後にJobのPodが消える
  template:
    metadata:
      labels:
        app: static-resource-upload-job-v1.0.0
        version: 1.0.0
        app.kubernetes.io/name: static-resource-upload-job
        app.kubernetes.io/version: 1.0.0
      annotations:
        sidecar.istio.io/inject: "false"
    spec:
      containers:
        - name: static-resource-upload-job
          env:
            - name: S3_REGION
              value: "upload-region"
            - name: S3_BUCKET
              value: "upload-bucket-name"
            - name: NPM_PACKAGE_NAME
              value: "npm package name"
            - name: NPM_PACKAGE_VERSION
              value: "version"
            - name: NPM_PACKAGE_DIST_DIR
              value: dist
            - name: UPLOAD_DIST_DIR
              value: "upload-dist-dir" # S3のKeyに該当
          image: # 静的リソースをアップロードするための処理が実装されたDocker Image
      restartPolicy: Never
```
