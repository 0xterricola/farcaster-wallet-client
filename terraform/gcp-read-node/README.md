# Snapchain read node on GCP — Terraform

The same validated config as `scripts/gcp-deploy.sh` (what the Cloud Shell
button runs), as a Terraform module for people who keep their infra in code.
One VM, one firewall rule, nothing else.

## Prereqs

```bash
gcloud auth application-default login   # ADC — Terraform reads these creds
```

## Deploy

```bash
cd terraform/gcp-read-node
terraform init
terraform plan  -var="project_id=YOUR_PROJECT_ID"   # preview, nothing created
terraform apply -var="project_id=YOUR_PROJECT_ID"   # creates VM + firewall
```

Outputs print the node IP and the exact next command:

```bash
fiddy provision --ssh ubuntu@<IP>   # then: fiddy node up && fiddy client up
```

## Tear down

```bash
terraform destroy -var="project_id=YOUR_PROJECT_ID"
```

## Notes

- **Sizing is not negotiable**: `e2-standard-4` (4 vCPU / 16 GB) + **2048 GB**
  boot disk. A mainnet read node needs 1.5–2 TB; smaller fills up mid-sync.
  (Generic templates default to e2-micro — that is a completely different
  workload.)
- **`pd-standard` (HDD) is deliberate**: new GCP projects cap regional SSD at
  500 GB, so a 2 TB SSD boot disk is rejected on fresh accounts. HDD has its
  own larger quota; bootstrap is overnight on HDD vs ~2h on SSD.
- The firewall opens 3381–3384/tcp + 3382,3384/udp to the world. Gossip
  (3382/3384) must be public or the node cannot peer. For anything
  long-running, lock 3381/3383 (the APIs) down to your own IP:
  `source_ranges = ["YOUR.IP.HERE/32"]` — but keep 3382/3384 open.
- Grafana lands on the node at `:3000` and stays private by design — use
  `fiddy node dashboard` (SSH tunnel) instead of opening the port.

## Alternative: GCP Infrastructure Manager

This module also works with [Infrastructure Manager](https://docs.cloud.google.com/infrastructure-manager/docs/overview)
(Google's managed Terraform — runs configs straight from a git repo, with a
Console "Deploy" button): create a deployment, point it at
`github.com/ivcained/fiddy` path `terraform/gcp-read-node`, set `project_id`.

We don't make it the default: Infra Manager needs a service account with the
right roles wired first, which is more setup than Cloud Shell's pre-authed
one click. If you already live in the GCP Console, it's the nicer long-term
surface — state and rollbacks managed for you.

