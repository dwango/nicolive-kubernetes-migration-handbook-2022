---
title: TypeScriptでKubernetesのmanifestを記述する
weight: 32
---

# TypeScriptでKubernetesのmanifestを記述する

ここでは基本的な書き方について紹介します。

## 基本的な書き方

NodeJSで動かすスクリプトとして次のようなに記述してきます。
これを`ts-node`などで実行すると`deployment.yml`が出力され、`kubectl apply -f deployment.yml`とすることでKubernetes上にPodが起動します。

```ts
import * as fs from "fs";
import * as yaml from "js-yaml";
import type { Schemas } from "@himenon/kubernetes-typescript-openapi/v1.22.3";

const podTemplateSpec: Schemas.io$k8s$api$core$v1$PodTemplateSpec = {
  metadata: {
    labels: {
      app: "nginx",
    },
  },
  spec: {
    containers: [
      {
        name: "nginx",
        image: "nginx:1.14.2",
        ports: [
          {
            containerPort: 80,
          },
        ],
      },
    ],
  },
};

const deployment: Schemas.io$k8s$api$apps$v1$Deployment = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: "nginx-deployment",
    labels: {
      app: "nginx",
    },
  },
  spec: {
    replicas: 3,
    selector: {
      matchLabels: {
        app: "nginx",
      },
    },
    template: podTemplateSpec,
  },
};

const text = yaml.dump(deployment, { noRefs: true, lineWidth: 144 });
fs.writeFileSync("deployment.yml", text, "utf-8");
```

## TypeScriptで記述する特徴

TypeScriptで記述したときの特徴を紹介します。

### YAMLの記法に悩まれなくて済む

まず一番わかりやすいのはYAMLの記法のブレがなくなります。
YAMLは出力された結果であり、その結果を出力する処理が記法を規格化するためYAMLの記法に関する一切のレビューが不要になります。

1. spaceかtab indentか
2. indentはspace 2か4か
3. 複数行コメントは`|`か`>`のどちらで初めるか
4. アルファベット順にソートするか

など。これらのことを一切考える必要がありません。

### コメントが書きやすい

TypeScriptのコードコメントがそのまま利用することができます。
エディタ上で変数名などをホバーしたときにコメントが見えるなどの可視化支援を受けることができます。

また、そのままドキュメントになるためマニフェストとドキュメントの乖離を防ぐことができ、ロストテクノロジーになることに対する予防措置が同時に実施できます。

```ts
/** podTemplateに対するコメント */
const podTemplateSpec: Schemas.io$k8s$api$core$v1$PodTemplateSpec = {};

const deployment: Schemas.io$k8s$api$apps$v1$Deployment = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: "nginx-deployment",
    labels: {
      /** このラベルを付ける理由.... */
      app: "nginx",
    },
  },
  spec: {
    /** replicasが3で妥当な理由... */
    replicas: 3,
    /** このSelectorを付ける理由.... */
    selector: {
      matchLabels: {
        app: "nginx",
      },
    },
    template: podTemplateSpec,
  },
};
```

### 「変数」が依存関係を表す様になる

Kubernetesで基本的なServiceとDeploymentというセットを考えたとき、Service間通信するためにはServiceのSelectorをPodのLabelと一致させる必要があります。これをTypeScriptで表現する場合、SelectorとLabelの部分を変数化してしまえば確実に疎通ができるServiceとDeploymentのマニフェストを生成することができます。

他にも[推奨されるラベル](https://kubernetes.io/ja/docs/concepts/overview/working-with-objects/common-labels/)にある`app.kubernetes.io/version`なども漏れなく適切に指定されるようになります。

```ts
const Namespace = "mynamespace";

export const generateService = (applicationName: string, applicationVersion: string): Schemas.io$k8s$api$core$v1$Service => {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: applicationName,
      namespace: Namespace,
    },
    spec: {
      type: "ClusterIP",
      selector: {
        app: applicationName,
        "app.kubernetes.io/name": applicationName,
      },
      ports: [
        {
          name: `http-${applicationName}-svc`,
          port: 80,
          targetPort: 80,
        },
      ],
    },
  };
}


export const generateDeployment = (applicationName: string, applicationVersion: string): Schemas.io$k8s$api$apps$v1$Deployment => {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: applicationName,
      namespace: Namespace,
      labels: {
        app: applicationName,
        "app.kubernetes.io/name": applicationName,
      },
      annotations: {},
    },
    spec: {
      selector: {
        matchLabels: {
          "app.kubernetes.io/name": applicationName,
        },
      },
      /** 省略 */
    },
  };
}

const applicationName = "my-nginx";
const applicationVersion = "1.14.2";

generateService(applicationName, applicationVersion);
generateDeployment(applicationName, applicationVersion);
```

### テンプレートの表現力が増す

例えばNodeJSやGo Lang、Scalaなど様々な言語で記述されているマイクロサービスの基本的なDeploymentのテンプレートなども用意できるようになります。これは例えば`/a`と`/b`のエンドポイントが同じサーバーから提供されているが、水平スケールする単位やCPU/MEMなどの各種リソースを分離して管理したい場合にManifestを分割したい場合に大いに役立ちます。うまくManifestのGeneratorが設計されていれば数分のオーダーで分割ができ、即日デプロイすることができます。
```ts
export const generateNodeJsDeployment = ():Schemas.io$k8s$api$apps$v1$Deployment => {};
export const generateRubyOnRailsDeployment = ():Schemas.io$k8s$api$apps$v1$Deployment => {};
export const generateScalaDeployment = ():Schemas.io$k8s$api$apps$v1$Deployment => {};
```

### Generator内部で`Error`を`throw`することがテストになる

ManifestをGenerateする際に立地なテストフレームワークは不要で、単純に`Exception`を発生させることがテストになります。
例えば`Service`や`Job`などのリソースタイプは`metadata.name`に指定可能な文字列や文字数が決まっています（[参照](https://kubernetes.io/ja/docs/concepts/overview/working-with-objects/names/#dns-label-names)）。

大きな変更が入った後に`kubectl apply`を実施して、この問題が発覚するとトラブルシュートの時間が掛かるため、ManifestをGenerateする際に具体的なエラーメッセージを出力して処理を中断してしまえば悩む時間が最小限にできます。
手元でGenerateせずにPull Request投げた場合はCIでGenerateを再度走らせてテストを実施することができます。

```ts
export const validateMetadataName = (text: string, throwError?: true): string => {
  if (throwError && text.length > 63) {
    throw new Error(`May not be deployed correctly because it exceeds 63 characters.\nValue: "${text}"`);
  }
  return text.slice(0, 63);
};

export const generateJob = (applicationName: string): Schemas.io$k8s$api$batch$v1$Job => {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: validateMetadataName(applicationName, true),
    },
  };
};
```
