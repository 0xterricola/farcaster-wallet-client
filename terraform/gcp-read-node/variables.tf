variable "project_id" {
  description = "GCP project ID to deploy into"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone"
  type        = string
  default     = "us-central1-a"
}

variable "name" {
  description = "Instance name"
  type        = string
  default     = "fiddy-node"
}

variable "machine_type" {
  description = "Machine type — 4 vCPU / 16 GB minimum for a mainnet read node"
  type        = string
  default     = "e2-standard-4"
}

variable "disk_gb" {
  description = "Boot disk size — a synced mainnet node needs 1.5–2 TB"
  type        = number
  default     = 2048
}

variable "ssh_user" {
  description = "SSH username to bake into instance metadata"
  type        = string
  default     = "ubuntu"
}

variable "ssh_pubkey" {
  description = "SSH public key line (contents of id_ed25519.pub). Leave empty to use OS Login / gcloud ssh."
  type        = string
  default     = ""
}
