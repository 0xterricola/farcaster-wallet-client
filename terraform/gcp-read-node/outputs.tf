output "ip" {
  description = "Public IP of the node"
  value       = google_compute_instance.node.network_interface[0].access_config[0].nat_ip
}

output "next_steps" {
  description = "What to run next"
  value       = "fiddy provision --ssh ubuntu@${google_compute_instance.node.network_interface[0].access_config[0].nat_ip} && fiddy node up"
}
