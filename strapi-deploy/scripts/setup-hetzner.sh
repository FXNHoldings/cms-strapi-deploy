#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu 22.04 / 24.04 Hetzner CX22 for the Strapi stack.
# Run as root on the new server:
#   curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/scripts/setup-hetzner.sh | bash
# or scp the file across and: sudo bash setup-hetzner.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

DEPLOY_USER=${DEPLOY_USER:-deploy}

echo ">>> Updating apt and installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg lsb-release ufw fail2ban git htop unattended-upgrades openssl

echo ">>> Creating deploy user ${DEPLOY_USER}"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  usermod -aG sudo "$DEPLOY_USER"
fi

# Copy root SSH keys to deploy user (so you can ssh in as deploy)
if [[ -f /root/.ssh/authorized_keys ]]; then
  mkdir -p /home/"$DEPLOY_USER"/.ssh
  cp /root/.ssh/authorized_keys /home/"$DEPLOY_USER"/.ssh/authorized_keys
  chown -R "$DEPLOY_USER":"$DEPLOY_USER" /home/"$DEPLOY_USER"/.ssh
  chmod 700 /home/"$DEPLOY_USER"/.ssh
  chmod 600 /home/"$DEPLOY_USER"/.ssh/authorized_keys
fi

echo ">>> Hardening SSH (disable root login + password auth)"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh || systemctl reload sshd || true

echo ">>> Configuring firewall (UFW)"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo ">>> Installing Docker Engine + Compose plugin"
install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker
usermod -aG docker "$DEPLOY_USER"

echo ">>> Enabling unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades || true

echo ">>> Done. Next steps:"
echo "  1. ssh ${DEPLOY_USER}@<server-ip>"
echo "  2. git clone <your-repo> ~/fxn-cms && cd ~/fxn-cms"
echo "  3. ./scripts/generate-secrets.sh >> .env   # then merge with .env.example"
echo "  4. Point DNS: cms.fxnstudio.com + www.fxnstudio.com A record -> server IP"
echo "  5. docker compose up -d --build"
