{{- define "dispatch.labels" -}}
app.kubernetes.io/name: dispatch
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end -}}

{{- define "dispatch.environment" -}}
- name: DISPATCH_HOST
  value: 0.0.0.0
- name: DISPATCH_PORT
  value: "3001"
- name: DISPATCH_ORIGIN
  value: {{ .Values.origin | quote }}
- name: DISPATCH_COMPANY_ID
  value: {{ .Values.company.id | quote }}
- name: DISPATCH_COMPANY_NAME
  value: {{ .Values.company.name | quote }}
- name: DISPATCH_DATA_DIR
  value: /data/state
- name: DISPATCH_WORKSPACE_DIR
  value: /data/workspace
- name: HOME
  value: /data/home
{{- end -}}
