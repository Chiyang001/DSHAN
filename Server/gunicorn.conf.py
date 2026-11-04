# Pair rooms live in one process. Do not increase workers without a shared room store.
bind = "0.0.0.0:8787"
workers = 1
worker_class = "gthread"
threads = 128
timeout = 0
graceful_timeout = 15
accesslog = None  # Avoid retaining client IPs and query strings in ordinary access logs.
errorlog = "-"
