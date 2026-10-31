FROM ghcr.io/trycua/linux@sha256:f01a87c27929a6f4250cae18d8b46ab04d8a21c0abf5fef30c3cca463a23a1d0

ARG WORKSPACE_SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/dispatchlabs-ai/dispatch" \
      org.opencontainers.image.revision="${WORKSPACE_SOURCE_REVISION}" \
      ai.dispatch.workspace.contract="dispatch-workspace-v1"

# Keep Cua's desktop command and healthcheck. Install the common development
# environment at image-build time, never as a side effect of starting a run.
USER root
ENV CUA_TELEMETRY=0 DO_NOT_TRACK=1
COPY dispatch-docker-start /usr/local/sbin/dispatch-docker-start
RUN printf '%s' "$WORKSPACE_SOURCE_REVISION" | grep -Eq '^[0-9a-f]{40}$' \
 && printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d \
 && chmod 0755 /usr/sbin/policy-rc.d /usr/local/sbin/dispatch-docker-start \
 && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/* \
 && apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      openssh-server git git-lfs ripgrep jq curl ca-certificates build-essential \
      python3-venv python3-pip poppler-utils postgresql redis-server \
      docker.io docker-buildx docker-compose-v2 iptables \
 && usermod -aG docker cua \
 && mkdir -p /workspace/deliverables /home/cua/.ssh \
 && chown -R cua:cua /workspace /home/cua/.ssh \
 && chmod 0700 /home/cua/.ssh \
 && rm -f /etc/ssh/ssh_host_* /home/cua/.ssh/authorized_keys \
 && printf '' >/etc/machine-id \
 && printf '{"format":1,"contract":"dispatch-workspace-v1","sourceRevision":"%s"}\n' \
      "$WORKSPACE_SOURCE_REVISION" >/etc/dispatch-workspace.json \
 && dpkg-query -W -f='${Package}\t${Version}\n' >/etc/dispatch-workspace-packages.tsv \
 && git --version && python3 --version && docker --version && docker compose version \
 && test -x /usr/sbin/sshd && test -x /usr/bin/pdfinfo \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
