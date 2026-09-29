#!/usr/bin/env python3
"""Find-or-create a Cloudflare Tunnel that publishes one hostname, point its DNS at the tunnel
(proxied CNAME) and write the connector token to a root-only env file.

Usage (as root): python3 cf_tunnel.py <tunnel name> <hostname> <local service URL> <env file>

The Cloudflare API token is read from Parameter Store /end-gfw/cloudflare/API_TOKEN (us-east-1;
the instance role end-gfw-main-ssm can read /end-gfw/*). It needs Account > Cloudflare Tunnel >
Edit and Zone > DNS > Edit. The tunnel secret is generated here and never printed; the connector
token can always be fetched again from the API, so it is not stored anywhere else.
"""
import base64, json, os, secrets, sys, urllib.error, urllib.request

import boto3

ACCOUNT = "b04c6896d3f12b035bd6e3c9499a8575"
API = "https://api.cloudflare.com/client/v4"


def token():
    ssm = boto3.client("ssm", region_name="us-east-1")
    return ssm.get_parameter(Name="/end-gfw/cloudflare/API_TOKEN", WithDecryption=True)["Parameter"]["Value"]


TOKEN = token()


def cf(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
    )
    try:
        res = json.load(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as e:
        res = json.load(e)
    if not res.get("success"):
        raise SystemExit(f"{method} {path.split('?')[0]}: {res.get('errors')}")
    return res["result"]


def main():
    name, host, service, env_file = sys.argv[1:5]

    tunnels = cf("GET", f"/accounts/{ACCOUNT}/cfd_tunnel?is_deleted=false&name={name}")
    if tunnels:
        tid = tunnels[0]["id"]
        print(f"tunnel {name} exists: {tid}")
    else:
        secret = base64.b64encode(secrets.token_bytes(32)).decode()
        tid = cf("POST", f"/accounts/{ACCOUNT}/cfd_tunnel",
                 {"name": name, "config_src": "cloudflare", "tunnel_secret": secret})["id"]
        print(f"tunnel {name} created: {tid}")

    cf("PUT", f"/accounts/{ACCOUNT}/cfd_tunnel/{tid}/configurations", {"config": {"ingress": [
        {"hostname": host, "service": service, "originRequest": {}},
        {"service": "http_status:404"},
    ]}})
    print(f"ingress {host} -> {service}")

    zone_name = ".".join(host.split(".")[-2:])
    zid = cf("GET", f"/zones?name={zone_name}")[0]["id"]
    target = f"{tid}.cfargotunnel.com"
    records = cf("GET", f"/zones/{zid}/dns_records?name={host}")
    want = {"type": "CNAME", "name": host, "content": target, "proxied": True, "ttl": 1,
            "comment": f"Cloudflare Tunnel {name}"}
    if records and len(records) == 1:
        r = records[0]
        if r["type"] == "CNAME" and r["content"] == target and r["proxied"]:
            print(f"dns {host} already -> tunnel")
        else:
            cf("PUT", f"/zones/{zid}/dns_records/{r['id']}", want)
            print(f"dns {host}: {r['type']} (proxied={r['proxied']}) -> proxied CNAME tunnel")
    else:
        for r in records:
            cf("DELETE", f"/zones/{zid}/dns_records/{r['id']}")
        cf("POST", f"/zones/{zid}/dns_records", want)
        print(f"dns {host}: created proxied CNAME tunnel")

    conn = cf("GET", f"/accounts/{ACCOUNT}/cfd_tunnel/{tid}/token")
    os.makedirs(os.path.dirname(env_file), mode=0o700, exist_ok=True)
    tmp = env_file + ".new"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(f"TUNNEL_TOKEN={conn}\n")
    os.replace(tmp, env_file)
    print(f"token written to {env_file}")


main()
