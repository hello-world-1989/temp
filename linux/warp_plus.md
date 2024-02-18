Cloudflare WARP packages
Cloudflare's client-side software can be installed on Linux with package managers APT or YUM by following these instructions. However, keep in mind that not all packages may support all operating systems or architectures and that you can check a specific package's page (linked from the homepage) to see what's available. We generally support modern versions of the following distributions:

Ubuntu
Debian
Red Hat Enterprise Linux & CentOS
Ubuntu
The supported releases are:
Jammy (22.04)
Focal (20.04)
Bionic (18.04)
Xenial (16.04)
# Add cloudflare gpg key
curl https://pkg.cloudflareclient.com/pubkey.gpg | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg


# Add this repo to your apt repositories
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list


# Install
sudo apt-get update && sudo apt-get install cloudflare-warp
		
Debian
The supported releases are:
Bookworm (12)
Bullseye (11)
Buster (10)
Stretch (9)
# Add cloudflare gpg key
curl https://pkg.cloudflareclient.com/pubkey.gpg | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg


# Add this repo to your apt repositories
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list


# Install
sudo apt-get update && sudo apt-get install cloudflare-warp
		
Red Hat Enterprise Linux & CentOS
Install the repository with yum (replace <VERSION> with the release version number):
The supported versions are:
8
# Add cloudflare-warp.repo to /etc/yum.repos.d/
curl -fsSl https://pkg.cloudflareclient.com/cloudflare-warp-ascii.repo | sudo tee /etc/yum.repos.d/cloudflare-warp.repo

# Update repo
sudo yum update

# Install
sudo yum install cloudflare-warp