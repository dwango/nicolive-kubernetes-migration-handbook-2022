---
title: アクセスログ
weight: 52
description: Istio IngressGatewayのPod内でnginxとfluent-bitアクセスログを収集するアーキテクチャを紹介します。
---

# アクセスログ

Webフロントエンドが管理するサーバーにおける最重要なシステムの一つは**アクセスログ**です。
不正アクセスなどのセキュリティ的な側面や、会社の収益のツリー構造に関わる部分など多くの重要な情報をここから得られます。
ゆえにこの部分のシステムは信頼度が最も高い方法で実現する必要があります。

したがって移行前のアーキテクチャをなるべく踏襲しつつ、Ingress Gatewayに近いところに配置する必要がありました。
また、ログは既存のfluentdの収集と連携する必要がありました。

最終的に本番で稼働しているアーキテクチャは次のようになります。

## Ingress Gatewayとアクセスログ周りのアーキテクチャ

![アクセスログの収集アーキテクチャ](../gateway-access-log.svg)

戦略としてはIngress Gatewayの前段にnginxを配置し、クラスター外からのアクセスを最初にnginxが受けるようにしました。nginxから出力されるアクセスログは`syslog`でUnix Socketを経由してfluent-bitに転送しています。
fluent-bitはsyslogをINPUTとして既存のfluentdと結合するために出力先のディレクトリとログの書き出しをコントロールしています。

このアーキテクチャに至った経緯を紹介します。

### アクセスログの出力にnginxを利用している理由

今回は移行が伴っているため、なるべく低コストで移行を安全に実施したい狙いがありました。
もともとnginxからログを出力していることもあり、その実績からそのまま流用する形を取りました。

また、envoyによるアクセスログの出力も考慮に入れましたが、Cookieなどに含まれる情報を出力するためにluaを書く必要があったり、そのパース用にスクリプト自体が保守するのが大変であるため断念しました。

### fluent-bitで収集してfluentdに渡している理由

fluentdは移行前からあるログ収集の手段です。
fluent-bitはfluentdのC言語実装で、fluent-bitも出力先をfluentdと同じ場所に向けることは可能です。
しかしながらこれも移行をスムーズに進めるために既存のfluentdの設定を頑張ってfluent-bitに移すことはしませんでした。

### nginxからfluent-bitにUnix Socket経由でログを送信している理由

最初、fluent-bitをDaemonSetとして配置してIngress Gateway用のNodeに配置するようにしていました。
nginxのログを`stdout`で出力し、`/var/log/containers/[containerId].log`に出力されるnginxのログをfluent-bitのtail INPUTを利用して収集していました。

しかしながら、高rps環境下でtailを利用するとfluent-bitのtailが突然止まる不具合に遭遇しました。
これはissueに起票されていますが、活発でないとしてBotによって2022/04/09クローズされました。

* https://github.com/fluent/fluent-bit/issues/3947

挙動を見ているとどうやら`/var/log/containers`に出力されるログファイルのシンボリックリンク先である、
`/var/log/pods/[pod-id]/0.log`が`.gz`ファイルにアーカイブされるときにファイルディスクリプタあたりが変更されそこでうまくfluent-bitが処理で基底なさそうだということがなんとなくわかっています。
とはいえこれを修正するためにfluent-bitにPull Requestを送って、リリースされるまでの間ログが収集できないとなると移行スケジュールに問題が発生するため別の方法を考えました。

幸い、AWSのfluent-bitのトラブルシューティングがあったのでここを参考にしました。

* https://github.com/aws/aws-for-fluent-bit/blob/mainline/troubleshooting/debugging.md

[Scaling](https://github.com/aws/aws-for-fluent-bit/blob/mainline/troubleshooting/debugging.md#scaling)の章に高スループットでfluent-bitを運用するための方法が紹介されており、そこに「DaemonSetモデルからSidecarモデルへ」と「ログファイルのTailからLog Streamingモデルへ」の変更が有効であることが記述されていました。

すぐにこれを採用し、最初に紹介したアーキテクチャへと変貌を遂げました

## 具体的な設定

これら理由を踏まえた上で設定は次のようになります。

### nginxの出力先の設定

ログは取り扱いしやすいように一度JSONで出力しています。
syslogは`/tmp/sidecar-nginx/sys-log.sock`に対して出力しています。

```nginx.conf
log_format json_access_format escape=json '{ 中略 }'
server {
  access_log syslog:server=unix:/tmp/sidecar-nginx/sys-log.sock json_access_format;
}
```

### fluent-bit

`INPUT`は`/tmp/sidecar-nginx/sys-log.sock`からnginxのログをJSON形式で読み込み、
syslog → JSON → 日付抽出 → タグの書き換え(出力先の調整)`FILTER`を通った後、
ファイルに書き出しています。

```ini {linenos=true,hl_lines=[15]}
[SERVICE]
    Flush               1
    Grace               120
    Daemon              off
    Parsers_File        parsers.conf
    HTTP_Server         On
    HTTP_Listen         0.0.0.0
    HTTP_PORT           2020
    Log_Level           info

[INPUT]
    Name                syslog
    Tag                 kube.*
    Path                /tmp/sidecar-nginx/sys-log.sock
    Parser              syslog-rfc3164-local
    Mode                unix_udp

[FILTER]
    Name                parser 
    Match               kube.*
    Key_Name            message
    Preserve_Key        true
    Reserve_Data        true
    Parser              json

[FILTER]
    Name                lua
    Match               kube.*
    script              create-log-file-path.lua
    call                create_log_file_path

[FILTER]
    Name                rewrite_tag
    Match               kube.*
    Rule                vhost ^(.*)$ /log/output/path/$log_file_path true

[PARSER]
    Name                nginx_access_log
    Format              regex
    Regex               ^(?<container_log_time>[^ ]+) (?<stream>stdout|stderr) (?<logtag>[^ ]*) (?<message>.*)$
    Time_Key            time
    Time_Format         %Y-%m-%dT%H:%M:%S%z
    Time_Keep           On

[PARSER]
    Name                syslog-rfc3164-local
    Format              regex
    Regex               ^<(?<pri>[0-9]+)>(?<time>[^ ]* {1,2}[^ ]* [^ ]*) (?<ident>[a-zA-Z0-9_/.-]*)(?:[(?<pid>[0-9]+)])?(?:[^:]*:)? *(?<message>.*)$
    Time_Key            time
    Time_Format         %b %d %H:%M:%S
    Time_Keep           On

[PARSER]
    Name               json
    Format             json

[OUTPUT]
    Name               file
    Match              *
    Format             template
    Template           method:{method}	uri:{uri} 中略
```

日付順で出力するために、以下のlua scriptを利用してTagを書き換えています。

```lua
-- create-log-file-path.lua
function create_log_file_path(tag, timestamp, record)
  new_record = record
  new_record["log_file_path"] = os.date("%Y-%m%d",timestamp).."/istio-ingressgateway-access.log"
  return 1, timestamp, new_record
end
```

### IstioOperator

KubernetesのManifestファイルは次のようになります

```yaml {linenos=true,hl_lines=[38,74,77]}
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: istio-my-ingressgateway
spec:
  profile: empty
  components:
    ingressGateways:
      - name: istio-my-ingressgateway
        enabled: true
        k8s:
          overlays:
            - apiVersion: apps/v1
              kind: Deployment
              name: istio-my-ingressgateway
              patches:
                - path: spec.template.spec.containers[1]
                  value:
                    name: sidecar-nginx
                    env:
                      - name: TZ
                        value: Asia/Tokyo
                    image: # nginx
                    securityContext:
                      privileged: true
                      runAsUser: 0
                      runAsGroup: 0
                      runAsNonRoot: false
                    volumeMounts:
                      - name: cache-volume
                        mountPath: /var/cache/nginx
                      - name: pid-volume
                        mountPath: /var/run
                      - name: ingressgateway-sidecar-nginx-conf
                        mountPath: /etc/nginx
                        readOnly: true
                      - name: nginx-unix-socket
                        mountPath: /tmp/sidecar-nginx # nginxのsyslog出力場所
                - path: spec.template.spec.containers[2]
                  value:
                    name: sidecar-fluent-bit
                    image: fluent/fluent-bit:1.8.13
                    imagePullPolicy: Always
                    ports:
                      - containerPort: 2020
                    securityContext:
                      privileged: true
                      runAsUser: 0
                      runAsGroup: 0
                      runAsNonRoot: false
                    readinessProbe:
                      httpGet:
                        path: /api/v1/metrics/prometheus
                        port: 2020
                      failureThreshold: 3
                      timeoutSeconds: 3
                    livenessProbe:
                      httpGet:
                        path: /
                        port: 2020
                      failureThreshold: 3
                      timeoutSeconds: 3
                    resources:
                      requests:
                        cpu: 150m
                        memory: 128Mi
                      limits:
                        cpu: 150m
                        memory: 128Mi
                    volumeMounts:
                      - name: sidecar-fluent-bit
                        mountPath: /fluent-bit/etc
                      - name: log-output-volume
                        mountPath: /log/output/path # fluent-bitのログの出力場所
                      - name: nginx-unix-socket
                        # fluent-bitがfluent-bitのUNIX Socketを読み込む場所
                        mountPath: /tmp/sidecar-nginx
                - path: spec.template.spec.volumes[8]
                  value:
                    name: ingressgateway-sidecar-nginx-conf
                    configMap:
                      name: ingressgateway-sidecar-nginx-conf
                      items:
                        - key: nginx.conf
                          path: nginx.conf
                - path: spec.template.spec.volumes[9]
                  value:
                    name: sidecar-nginx-error-page
                    configMap:
                      name: sidecar-nginx-error-page
                - path: spec.template.spec.volumes[10]
                  value:
                    name: cache-volume
                    emptyDir: {}
                - path: spec.template.spec.volumes[11]
                  value:
                    name: pid-volume
                    emptyDir: {}
                - path: spec.template.spec.volumes[12]
                  value:
                    name: varlog
                    hostPath:
                      path: /var/log
                - path: spec.template.spec.volumes[13]
                  value:
                    name: sidecar-fluent-bit
                    configMap:
                      name: sidecar-fluent-bit
                - path: spec.template.spec.volumes[14]
                  value:
                    name: log-output-volume
                    hostPath:
                      path:  /log/output/path
                - path: spec.template.spec.volumes[15]
                  value:
                    name: nginx-unix-socket
                    emptyDir: {}
```

`/tmp/sidecar-nginx`に対してUnix Socket用のEmpty Directoryを作成し、Pod内でシェアすることでPodとして見たときにポータビリティが確保できます。

IstioOperatorで新しくContainerやVolumeを追加する場合は現状 `k8s.overlays` で頑張って追加するしかありませんが、
[ManifestをTypeScriptで管理](/docs/03/kubernetes-manifest-written-by-typescript/)しているため、管理が難しいなどの問題は発生しませんでした。

ただしバージョンアップに伴ってIstioOperatorが作成するIngressGatewayのDeploymentを確認する必要があります。
早々バージョン更新の頻度は高くないので、バージョン更新後の検証と同時にやっても問題ないでしょう。

## これから

ここまでに説明したことを改めて整理すると、移行時に飲み込んだ冗長的な部分を最適化することがまずできます。

1. nginxのログ出力をIngress Gatewayのistio-proxyで実施する
2. fluentdによるログ転送処理をfluent-bitに移行する

これらを実施することで`IstioOperator`のManifestはある程度見やすくなります。
