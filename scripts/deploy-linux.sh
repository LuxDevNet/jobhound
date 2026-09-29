#!/usr/bin/env bash
set -e

echo "=== Jobhound Linux Setup & Worker Launcher ==="

# Check Node.js >= 20
if ! command -v node &> /dev/null; then
    echo "Installing Node.js 22 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo "Node version: $(node -v)"
echo "NPM version: $(npm -v)"

# Install dependencies
npm install

# Install Playwright browser dependencies for Linux
echo "Installing Playwright Linux system dependencies..."
npx playwright install --with-deps chromium

echo ""
echo "=== Ready to Run ==="
echo "Single local run:"
echo "  npx tsx src/cli.ts run -k 'software engineer' -l 'San Diego, CA'"
echo ""
echo "Distributed shard run (e.g. Node 1 of 5):"
echo "  npx tsx src/cli.ts run -k 'software engineer' -l 'San Diego, CA' --shards 5 --shard 0"
echo ""
