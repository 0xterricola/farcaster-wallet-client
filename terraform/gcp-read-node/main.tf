# Snapchain read node on GCP — the whole unit.
# Validated config from our own run: e2-standard-4, Ubuntu 24.04, 2 TB
# pd-standard boot (dodges the 500 GB new-project SSD quota), Docker + cron
# preinstalled, firewall for the Snapchain ports.
#
#   terraform init
#   terraform apply -var="project_id=YOUR_PROJECT"
#
# ~$165/mo while running. terraform destroy tears everything down.
# (Architecture informed by github.com/standard-crypto/farcaster-hub-gcp —
# their module targets the retired Hub on GKE; this one is Snapchain on a
# single VM.)

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = ">= 5.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

resource "google_compute_firewall" "snapchain" {
  name    = "snapchain-node"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["3381-3384"]
  }
  allow {
    protocol = "udp"
    ports    = ["3382", "3384"]
  }

  # Gossip must face the world or the node cannot peer. The HTTP/gRPC APIs
  # (3381/3383) are included here for a quick start; lock them to your own IP
  # for anything long-running.
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["snapchain-node"]
}

resource "google_compute_instance" "node" {
  name         = var.name
  machine_type = var.machine_type
  tags         = ["snapchain-node"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.disk_gb
      type  = "pd-standard" # HDD: new projects cap regional SSD at 500 GB
    }
  }

  network_interface {
    network = "default"
    access_config {} # ephemeral public IP
  }

  metadata = {
    ssh-keys = var.ssh_pubkey == "" ? null : "${var.ssh_user}:${var.ssh_pubkey}"
  }

  metadata_startup_script = <<-EOF
    #!/bin/bash
    curl -fsSL https://get.docker.com | sh
    apt-get install -y cron
    systemctl enable --now cron
  EOF
}
