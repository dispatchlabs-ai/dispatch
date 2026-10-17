{{- define "dispatch-workers.labels" -}}
app.kubernetes.io/name: dispatch-workers
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end -}}

{{- define "dispatch-workers.validate" -}}
{{- $_ := required "Set installationId" .Values.installationId -}}
{{- $_ := required "Set configurationRevision" .Values.configurationRevision -}}
{{- $_ := required "Set company.id" .Values.company.id -}}
{{- $_ := required "Set company.name" .Values.company.name -}}
{{- if not (regexMatch "^https://[A-Za-z0-9.-]+(:[0-9]+)?$" .Values.origin) -}}
{{- fail "Set origin to a canonical HTTPS origin without a path or trailing slash" -}}
{{- end -}}
{{- range $role, $image := .Values.images -}}
{{- $_ := required (printf "Set images.%s.repository" $role) $image.repository -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $image.digest) -}}
{{- fail (printf "Pin images.%s.digest to an immutable sha256 digest" $role) -}}
{{- end -}}
{{- end -}}
{{- range $key, $name := .Values.secrets -}}
{{- $_ := required (printf "Set secrets.%s to an existing role-scoped Secret" $key) $name -}}
{{- end -}}
{{- range $key, $pem := .Values.trust -}}
{{- if or (not (contains "-----BEGIN CERTIFICATE-----" $pem)) (contains "PRIVATE KEY" $pem) -}}
{{- fail (printf "Set trust.%s to public CA certificate PEM" $key) -}}
{{- end -}}
{{- end -}}
{{- if not .Values.artifacts.existingClaim -}}
{{- $_ := required "Set artifacts.storageClass or artifacts.existingClaim" .Values.artifacts.storageClass -}}
{{- end -}}
{{- $_ := required "Set networkPolicy.databaseCidrs" .Values.networkPolicy.databaseCidrs -}}
{{- $_ := required "Set networkPolicy.apiServerCidrs" .Values.networkPolicy.apiServerCidrs -}}
{{- if and .Values.ingress.enabled (not .Values.networkPolicy.ingressCidrs) -}}
{{- fail "Set networkPolicy.ingressCidrs to the ingress controller's source ranges" -}}
{{- end -}}
{{- end -}}

{{- define "dispatch-workers.backendFiles" -}}
{{- $files := dict "database-ca.pem" .Values.trust.databaseCaPem "backend-ca.pem" .Values.trust.backendCaPem -}}
{{- range $store := list "auth" "provider" "catalog" "routing" "directory" -}}
{{- $config := dict "databaseUrlFile" (printf "/tmp/dispatch-bootstrap/%s-db-url" $store) "databaseCaFile" "/tmp/dispatch-bootstrap/database-ca.pem" -}}
{{- if eq $store "directory" -}}
{{- $_ := set $config "storeId" (printf "%s:directory" $.Values.installationId) -}}
{{- else -}}
{{- $_ := set $config "installationId" $.Values.installationId -}}
{{- end -}}
{{- if has $store (list "auth" "provider" "catalog") -}}
{{- $_ := set $config "encryptionKeyFile" (printf "/tmp/dispatch-bootstrap/%s-key" $store) -}}
{{- end -}}
{{- $_ := set $files (printf "%s.json" $store) (toJson $config) -}}
{{- end -}}
{{- $backend := dict
  "installationId" .Values.installationId
  "configurationRevision" .Values.configurationRevision
  "authStoreConfigFile" "/tmp/dispatch-bootstrap/auth.json"
  "providerStoreConfigFile" "/tmp/dispatch-bootstrap/provider.json"
  "mcpStoreConfigFile" "/tmp/dispatch-bootstrap/catalog.json"
  "routingStoreConfigFile" "/tmp/dispatch-bootstrap/routing.json"
  "directoryStoreConfigFile" "/tmp/dispatch-bootstrap/directory.json"
  "postgresStores" (dict "adminUrlFile" "/tmp/dispatch-bootstrap/workers-db-url" "caFile" "/tmp/dispatch-bootstrap/database-ca.pem")
  "tls" (dict "keyFile" "/tmp/dispatch-bootstrap/backend-key.pem" "certFile" "/tmp/dispatch-bootstrap/backend-cert.pem")
  "artifacts" (dict "kind" "filesystem" "directory" "/artifacts")
  "workerKeyFile" "/tmp/dispatch-bootstrap/worker-token"
  "launcherTokenFile" "/tmp/dispatch-bootstrap/launcher-token"
  "operatorTokenFile" "/tmp/dispatch-bootstrap/operator-token"
  "launcherUrl" (printf "http://%s-launcher.%s.svc:8830" .Release.Name .Release.Namespace)
-}}
{{- $_ := set $files "backend.json" (toJson $backend) -}}
{{- toJson $files -}}
{{- end -}}

{{- define "dispatch-workers.launcherFiles" -}}
{{- $driver := dict
  "namespace" .Release.Namespace
  "image" (printf "%s@%s" .Values.images.worker.repository .Values.images.worker.digest)
  "configurationRevision" .Values.configurationRevision
  "serviceAccountName" .Values.worker.serviceAccountName
  "environment" (dict "DISPATCH_BACKEND_INTERNAL_URL" (printf "https://%s-backend.%s.svc:3001" .Release.Name .Release.Namespace))
  "resources" .Values.worker.resources
  "workspaceSizeLimit" .Values.worker.workspaceSizeLimit
  "tmpSizeLimit" .Values.worker.tmpSizeLimit
  "stopGraceSeconds" .Values.worker.stopGraceSeconds
  "requestTimeoutMs" .Values.worker.requestTimeoutMs
  "retirementTimeoutMs" .Values.worker.retirementTimeoutMs
-}}
{{- $launcher := dict
  "installationId" .Values.installationId
  "postgres" (dict "urlFile" "/tmp/dispatch-bootstrap/launcher-db-url" "caFile" "/tmp/dispatch-bootstrap/database-ca.pem")
  "tokenFile" "/tmp/dispatch-bootstrap/launcher-token"
  "workerKeyFile" "/tmp/dispatch-bootstrap/worker-token"
  "backendCaFile" "/tmp/dispatch-bootstrap/backend-ca.pem"
  "host" "0.0.0.0" "port" 8830 "driverType" "kubernetes" "driver" $driver
-}}
{{- toJson (dict "database-ca.pem" .Values.trust.databaseCaPem "backend-ca.pem" .Values.trust.backendCaPem "launcher.json" (toJson $launcher)) -}}
{{- end -}}

{{- define "dispatch-workers.secretFiles" -}}
{{- if eq .role "backend" -}}
{{- $files := dict -}}
{{- range $store := list "auth" "provider" "catalog" "directory" "routing" "workers" -}}
{{- $name := printf "%s-db-url" $store -}}
{{- $_ := set $files $name (dict "secret" $.root.Values.secrets.backend "key" $name "encoding" "utf8") -}}
{{- end -}}
{{- range $store := list "auth" "provider" "catalog" -}}
{{- $name := printf "%s-key" $store -}}
{{- $_ := set $files $name (dict "secret" $.root.Values.secrets.backend "key" $name "encoding" "base64") -}}
{{- end -}}
{{- range $token := list "worker" "launcher" "operator" -}}
{{- $name := printf "%s-token" $token -}}
{{- $_ := set $files $name (dict "secret" $.root.Values.secrets.backend "key" $name "encoding" "utf8") -}}
{{- end -}}
{{- $_ := set $files "backend-key.pem" (dict "secret" .root.Values.secrets.backendTls "key" "tls.key" "encoding" "utf8") -}}
{{- $_ := set $files "backend-cert.pem" (dict "secret" .root.Values.secrets.backendTls "key" "tls.crt" "encoding" "utf8") -}}
{{- toJson $files -}}
{{- else -}}
{{- $files := dict -}}
{{- range $name := list "launcher-db-url" "launcher-token" "worker-token" -}}
{{- $_ := set $files $name (dict "secret" $.root.Values.secrets.launcher "key" $name "encoding" "utf8") -}}
{{- end -}}
{{- toJson $files -}}
{{- end -}}
{{- end -}}

{{- define "dispatch-workers.environment" -}}
{{- $root := .root -}}
{{- $role := .role -}}
{{- $files := include (printf "dispatch-workers.%sFiles" $role) $root | fromJson -}}
{{- $secrets := include "dispatch-workers.secretFiles" . | fromJson -}}
{{- $manifest := dict -}}
{{- range $name, $content := $files -}}
{{- $_ := set $manifest $name (dict "env" (printf "DISPATCH_FILE_%s" (upper (replace "." "_" (replace "-" "_" $name)))) "encoding" "utf8") -}}
{{- end -}}
{{- range $name, $entry := $secrets -}}
{{- $_ := set $manifest $name (dict "env" (printf "DISPATCH_SECRET_%s" (upper (replace "." "_" (replace "-" "_" $name)))) "encoding" $entry.encoding) -}}
{{- end -}}
- name: DISPATCH_HOST
  value: 0.0.0.0
- name: DISPATCH_PORT
  value: "3001"
- name: DISPATCH_ORIGIN
  value: {{ $root.Values.origin | quote }}
- name: DISPATCH_COMPANY_ID
  value: {{ $root.Values.company.id | quote }}
- name: DISPATCH_COMPANY_NAME
  value: {{ $root.Values.company.name | quote }}
- name: DISPATCH_DATA_DIR
  value: /data/state
- name: DISPATCH_WORKSPACE_DIR
  value: /workspace
- name: HOME
  value: /data/home
{{- if eq $role "backend" }}
- name: DISPATCH_SERVE_CLIENT
  value: "true"
{{- end }}
- name: {{ if eq $role "backend" }}DISPATCH_BACKEND_WORKERS_CONFIG_FILE{{ else }}DISPATCH_LAUNCHER_CONFIG_FILE{{ end }}
  value: {{ printf "/tmp/dispatch-bootstrap/%s.json" $role | quote }}
- name: DISPATCH_BOOTSTRAP_FILES
  value: {{ toJson $manifest | quote }}
{{- range $name, $content := $files }}
- name: {{ (index $manifest $name).env }}
  valueFrom:
    configMapKeyRef:
      name: {{ $root.Release.Name }}-config
      key: {{ $name }}
{{- end }}
{{- range $name, $entry := $secrets }}
- name: {{ (index $manifest $name).env }}
  valueFrom:
    secretKeyRef:
      name: {{ $entry.secret | quote }}
      key: {{ $entry.key | quote }}
{{- end }}
{{- end -}}

{{- define "dispatch-workers.dnsEgress" -}}
- to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
  ports:
    - {port: 53, protocol: UDP}
    - {port: 53, protocol: TCP}
{{- if .Values.networkPolicy.dnsCidrs }}
- to:
    {{- range .Values.networkPolicy.dnsCidrs }}
    - ipBlock:
        cidr: {{ . | quote }}
    {{- end }}
  ports:
    - {port: 53, protocol: UDP}
    - {port: 53, protocol: TCP}
{{- end }}
{{- end -}}

{{- define "dispatch-workers.databaseEgress" -}}
- to:
    {{- range .Values.networkPolicy.databaseCidrs }}
    - ipBlock:
        cidr: {{ . | quote }}
    {{- end }}
  ports:
    - {port: 5432, protocol: TCP}
{{- end -}}

{{- define "dispatch-workers.publicEgress" -}}
- to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 127.0.0.0/8]
{{- end -}}
