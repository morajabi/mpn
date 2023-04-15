#! /usr/bin/env node
import fs from "fs";
import path from "path";
import { NodeSSH } from "node-ssh";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import prompts, { PromptObject } from "prompts";
import { SSHExecCommandResponse } from "node-ssh";
import { $ } from "execa";
const argv = yargs(hideBin(process.argv)).argv;

function fromArgs(arg: string): string | undefined {
  return arg in argv && typeof argv[arg] === "string" ? argv[arg] : undefined;
}

const questions: Array<PromptObject<string>> = [
  // {
  //   type: "text",
  //   name: "host",
  //   message: "Host/IP",
  //   initial: fromArgs("host"),
  // },
  // {
  //   type: "text",
  //   name: "username",
  //   message: "Username",
  //   initial: "root",
  // },
  // {
  //   type: "password",
  //   name: "password",
  //   message: "Password",
  //   initial: fromArgs("password"),
  // },
  {
    type: "select",
    name: "setup",
    message: "Pick a setup (VPN, etc)",
    choices: [
      { title: "OpenVPN with stunnel", description: "Nice", value: "openvpn" },
      { title: "VLess + XTLS", value: "vless" },
    ],
  },
  {
    // type:(_,values) => values.setup == "vless" ? 'text' : null,
    type: "text",
    name: "domain",
    message: "Enter your domain without http or www",
    initial: fromArgs("domain"),
  },
  {
    // type: (_,values) => values.setup == "vless" ? 'text' : null,
    type: "text",
    name: "email",
    message: "Enter your email",
    initial: fromArgs("email"),
  },
];

(async () => {
  const response = await prompts(questions);

  // const ssh = new NodeSSH();

  // let conn = await ssh.connect({
  //   host: response.host,
  //   username: response.username,
  //   password: response.password,
  // });

  console.log("connected to server.");

  if (response.setup === "vless") {
    // let domain = response.domain;
    // let email = response.email;
    // if (!domain) return console.error("domain invalid");
    // if (!email || !email.includes("@")) return console.error("email invalid");
    // await vless(conn, response.domain, response.email);
  } else {
    await openvpn2();
  }
})();

const isVerbose = "v" in argv;
async function cmd(ch: ReturnType<typeof $>) {
  let x = await ch;

  if (isVerbose) {
    console.info(x.stdout);
  }

  if (x.failed) {
    console.error("Failed to run", x.command);
    console.info(x.stdout);
    console.error(x.stderr);
    throw new Error("Command failed.");
  }
}

async function openvpn2() {
  let $$ = $({ verbose: true });
  // prep
  await cmd($$`apt-get update`);
  await cmd($$`apt-get upgrade -y`);
  await cmd($$`apt-get install curl socat make -y`);

  // docker
  await cmd($$`sudo apt-get install ca-certificates curl gnupg -y`);
  await cmd($$`sudo install -m 0755 -d /etc/apt/keyrings`);
  await cmd(
    $$`curl -fsSL https://download.docker.com/linux/ubuntu/gpg`.pipeStdout(
      $$`sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg --batch --yes`
      // $$`sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes`
    )
  );
  await cmd($$`sudo chmod a+r /etc/apt/keyrings/docker.gpg`);
  let arch = await $$`dpkg --print-architecture`;
  let kinetic = await $$`. /etc/os-release && echo "$VERSION_CODENAME"`;
  await cmd(
    $`echo "deb [arch="${arch}" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu "${kinetic}" stable"`.pipeStdout(
      $$`sudo tee /etc/apt/sources.list.d/docker.list`
    )
    // .pipeStdout(`/dev/null`)
  );
  await cmd($$`sudo apt-get update`);
  await cmd(
    $`sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y`
  );
  await cmd($$`sudo systemctl enable docker.service`);
  await cmd($$`sudo systemctl enable containerd.service`);
  // await cmd($`sudo systemctl start docker.service`);
  // await cmd($`sudo systemctl start containerd.service`);

  // open ports
  await cmd($`ufw allow 993`);
  await cmd($`ufw allow 443`);
  await cmd($`ufw allow 80`);
  await cmd($`ufw allow ssh`);
  await cmd($`ufw enable`);

  // clone
  const openVpnRepoDir = `/root/docker-stealth-openvpn`;
  await cmd(
    $({ reject: false, cwd: "/root" })`rm -rf /root/docker-stealth-openvpn`
  );
  await cmd($`git clone https://github.com/morajabi/docker-stealth-openvpn`);
  await cmd($({ cwd: openVpnRepoDir })`./bin/init.sh`);
  await cmd($({ cwd: openVpnRepoDir })`docker compose up -d`);

  // create clients
  const configsDir = `/root/configs`;
  await cmd($({ cwd: `/root` })`mkdir ${configsDir}`);

  const users = ["c1", "c2", "c3", "c4"];
  for (let username of users) {
    let confPath = path.join(configsDir, `${username}.ovpn`);
    await cmd(
      $({
        cwd: openVpnRepoDir,
      })`docker compose run --rm openvpn easyrsa build-client-full "${username}" nopass`
    );
    await cmd(
      $({
        cwd: openVpnRepoDir,
      })`docker compose run --rm openvpn ovpn_getclient "${username}"`.pipeStdout(
        confPath
      )
    );
    await cmd(
      $({
        cwd: openVpnRepoDir,
      })`sudo sed -i "s/^remote .*\r$/remote 127.0.0.1 41194 tcp\r/g" "${confPath}"`
    );
  }
}

const root = "/root";
async function installPre(conn: NodeSSH) {
  // sudo apt-get update -y
  // sudo apt-get upgrade -y
  // sudo apt install curl -y
  await run(
    conn.execCommand("apt-get update && apt-get upgrade -y", { cwd: root })
  );
  await run(conn.execCommand("apt-get install curl socat -y", { cwd: root }));
  await run(conn.execCommand("sudo apt-get install -y make", { cwd: root }));
}

async function openvpn(conn: NodeSSH) {
  console.info("installing curl, etc");
  await installPre(conn);

  // install docker
  await installDocker(conn);

  // open ufw 993 and 80
  await openPorts(conn, 80, 443, 993);

  // clone project
  await installAndInitOpenVpn(conn);

  // generate 4 clients and export them to /Users/mo/movpn/connections
  await createOpenVpnUsers(conn, ["mo", "dena", "ben", "moein"]);
}

async function installDocker(conn: NodeSSH) {
  let commands = [
    "sudo apt-get remove docker docker-engine docker.io containerd runc",
    "sudo apt-get update",
    "sudo apt-get install ca-certificates curl gnupg -y",
    "sudo install -m 0755 -d /etc/apt/keyrings",
    "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg --batch --yes",
    // "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg --no-tty --batch --yes",
    "sudo chmod a+r /etc/apt/keyrings/docker.gpg",
    `echo "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null`,
    `sudo apt-get update`,
    `sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y`,
    `sudo systemctl enable docker.service`,
    `sudo systemctl enable containerd.service`,
    `sudo systemctl start docker.service`,
    `sudo systemctl start containerd.service`,
    // docker compose
    // `sudo curl -L "https://github.com/docker/compose/releases/download/1.29.2/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose`,
    // `sudo chmod +x /usr/local/bin/docker-compose`,
  ];

  return runSteps(conn, "docker install", commands);
}

async function installAndInitOpenVpn(conn: NodeSSH) {
  const repoDir = "/root/docker-stealth-openvpn";

  let commands = [
    // `rm -rf ${repoDir}`,
    "mkdir docker-stealth-openvpn",
    "git clone https://github.com/morajabi/docker-stealth-openvpn",
    "cd docker-stealth-openvpn",

    // STDOUT: Command may disrupt existing ssh connections. Proceed with operation (y|n)? Aborted
    // running clone and init openvpn 6 steps
    // running: mkdir docker-stealth-openvpn
    // STDOUT:
    // running: git clone https://github.com/morajabi/docker-stealth-openvpn
    // STDOUT:
    // STDERR: Cloning into 'docker-stealth-openvpn'...
    // running: cd docker-stealth-openvpn
    // STDOUT:
    // STDOUT:
    // STDERR: bash: line 1: cd: /root/docker-stealth-openvpn: No such file or directory
    // bash: line 1: ./bin/init.sh: No such file or directory
    // STDOUT: docker-stealth-openvpn
    // snap
    // STDERR: bash: line 1: cd: /root/docker-stealth-openvpn: No such file or directory
    // STDOUT:
    // STDERR: bash: line 1: cd: /root/docker-stealth-openvpn: No such file or directory
    // no configuration file provided: not found
    // creating client mo
    // running create client 4 steps
    // running: mkdir /root/configs
    // STDOUT:
    // STDOUT:
    conn.execCommand(
      `./bin/init.sh`,
      // `chmod +x ${repoDir}/bin/init.sh && ${repoDir}/bin/init.sh`,
      {
        cwd: repoDir,
      }
    ),

    conn.execCommand("ls", {
      cwd: repoDir,
    }),

    conn.execCommand("docker compose up -d", {
      cwd: repoDir,
    }),
  ];

  // let revert = [
  //   conn.execCommand("docker compose kill", { cwd: repoDir }),
  //   "rm -rf docker-stealth-openvpn",
  // ];

  return runSteps(conn, "clone and init openvpn", commands);
}
async function createOpenVpnUsers(conn: NodeSSH, clients: string[]) {
  const repoDir = "/root/docker-stealth-openvpn";
  const confgDir = "/root/configs";
  const localConfigsDir = path.join(process.env.HOME, "movpn");
  // docker-compose run --rm openvpn easyrsa build-client-full "$USERNAME" nopass
  // docker-compose run --rm openvpn ovpn_getclient "$USERNAME" > "$CONFIG_PATH"

  for (let client of clients) {
    console.info("creating client", client);
    const confgPath = `${confgDir}/${client}.ovpn`;
    let commands = [
      `mkdir ${confgDir}`,
      conn.execCommand(
        `docker compose run --rm openvpn easyrsa build-client-full "${client}" nopass`,
        { cwd: repoDir }
      ),
      conn.execCommand(
        `docker compose run --rm openvpn ovpn_getclient "${client}" > "${confgPath}"`,
        { cwd: repoDir }
      ),
      // conn.execCommand(
      conn.execCommand(
        `sudo sed -i "s/^remote .*\r$/remote 127.0.0.1 41194 tcp\r/g" "${confgPath}"`,
        { cwd: repoDir }
      ),
      // `sed -i "s/^remote .*\r$/remote localhost 41194 tcp\r/g" "${confgPath}"`,
      // { cwd: root }
      // ),
    ];
    await runSteps(conn, "create client", commands);
    // await conn.getFile(path.join(localConfigsDir, `${client}.ovpn`), confgPath);
  }

  console.info("Configs:", localConfigsDir);
}

type Command = string | Promise<SSHExecCommandResponse>;

async function runSteps(
  conn: NodeSSH,
  title: string,
  commands: Command[],
  revert?: Command[]
) {
  console.info("running", title, commands.length, "steps");

  try {
    for (let command of commands) {
      if (typeof command == "string") {
        console.info("running:", command);
        await run(conn.execCommand(command, { cwd: root }));
      } else {
        await run(command);
      }
    }
  } catch (error) {
    if (revert) {
      // todo run revert commands on failure
    }
    throw new Error(`Failed to run ${title}`);
  }
}

async function openPorts(conn: NodeSSH, ...ports: number[]) {
  console.info("opening ports", ...ports);

  for (let port of ports) {
    await run(conn.execCommand(`ufw allow ${port}`));
  }
  await run(conn.execCommand(`ufw allow ssh`));
  await run(conn.execCommand(`ufw enable`));
}

async function setupCaddy(conn: NodeSSH) {
  let commands = [
    "sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https",
    "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
    "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list",
    "sudo apt-get update",
    "sudo apt-get install caddy",
  ];

  // Caddyfile
  // www.superchargejs.com {
  //   redir https://superchargejs.com{uri} permanent
  // }
}

async function vless(conn: NodeSSH, domain: string, email: string) {
  console.info("installing curl, etc");
  await installPre(conn);

  console.info("setup firewall");
  await run(conn.execCommand("ufw allow 443", { cwd: root }));
  await run(conn.execCommand("ufw allow 80", { cwd: root }));

  // install cert
  console.info("installing certs");
  await run(conn.execCommand("curl https://get.acme.sh | sh", { cwd: root }));
  await run(
    conn.execCommand(
      "~/.acme.sh/acme.sh --set-default-ca --server letsencrypt",
      { cwd: root }
    )
  );
  await run(
    conn.execCommand(`~/.acme.sh/acme.sh --register-account -m ${email}`, {
      cwd: root,
    })
  );
  await run(
    conn.execCommand(`~/.acme.sh/acme.sh --issue -d ${domain} --standalone`, {
      cwd: root,
    })
  );

  // ca.cer	       npn.airpods.wtf.cer   npn.airpods.wtf.csr       npn.airpods.wtf.key
  // fullchain.cer  npn.airpods.wtf.conf  npn.airpods.wtf.csr.conf
  // copy certs
  let certs = "/root/certs";
  await run(conn.execCommand(`mkdir -p ${certs}`, { cwd: root }));
  await run(
    conn.execCommand(`cp /root/.acme.sh/${domain}_ecc/* ${certs}`, {
      cwd: root,
    })
  );

  // intall
  let fullchain = `${certs}/fullchain.cer`;
  let publicKey = `${certs}/${domain}.cer`;
  let privateKey = `${certs}/${domain}.key`;

  console.info("---- certs created ----");
  console.info("domain: ", domain);
  console.info("publicKey: ", publicKey);
  console.info("privateKey: ", privateKey);

  console.info("applying certs");
  await run(
    conn.execCommand(
      `~/.acme.sh/acme.sh --installcert -d ${domain} --key-file ${privateKey} --fullchain-file ${fullchain}`,
      { cwd: root }
    )
  );

  // vless
  // bash <(curl -Ls https://raw.githubusercontent.com/vaxilu/x-ui/master/install.sh)
  console.info("installing x-ui");
  await run(
    conn.execCommand(
      "bash <(curl -Ls https://raw.githubusercontent.com/vaxilu/x-ui/master/install.sh)",
      { cwd: root }
    )
  );
  console.info("x-ui installed");

  // config x-ui
  // /usr/local/x-ui/x-ui setting -username ${config_account} -password ${config_password}
  //  echo -e "${yellow}账户密码设定完成${plain}"
  //  /usr/local/x-ui/x-ui setting -port
  let port = "54321";
  let username = "admin";
  let password = "amazing1212";
  await run(
    conn.execCommand(
      `/usr/local/x-ui/x-ui setting -username ${username} -password ${password} -port ${port}`,
      { cwd: root }
    )
  );
  console.info("x-ui config:");
  console.info("password:", password);
  console.info("username:", username);
  console.info("port:", port);
  await run(conn.execCommand(`ufw allow ${port}`, { cwd: root }));
}

async function run(execPromise: Promise<SSHExecCommandResponse>) {
  return execPromise.then(function (result) {
    if ("v" in argv) {
      console.log("STDOUT: " + result.stdout);
    }
    if (result.stderr) {
      console.error("STDERR: " + result.stderr);

      if (
        result.stderr.includes("Password change required but no TTY available")
      ) {
        console.info("Hint:");
        console.info("SSH and change the server password.");
      }
    }
  });
}
