{
  description = "mattermost-exporter — Mattermost channel exporter (JSON + attachments) with an OpenTUI interface";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, bun2nix }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ bun2nix.overlays.default ];
        };

        # Single self-contained executable (Bun runtime embedded).
        # Dependencies come from bun.lock -> bun.nix (committed) via bun2nix,
        # so the build is hermetic and node_modules stays git-ignored.
        mattermost-exporter = pkgs.bun2nix.mkDerivation {
          pname = "mattermost-exporter";
          version = "0.1.0";
          src = self;

          bunDeps = pkgs.bun2nix.fetchBunDeps { bunNix = ./bun.nix; };

          buildPhase = ''
            runHook preBuild
            export HOME=$TMPDIR
            bun build --compile src/index.ts --outfile mattermost-exporter
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            install -Dm755 mattermost-exporter $out/bin/mattermost-exporter
            runHook postInstall
          '';
        };
      in
      {
        packages = {
          default = mattermost-exporter;
          inherit mattermost-exporter;
        };

        apps.default = {
          type = "app";
          program = "${mattermost-exporter}/bin/mattermost-exporter";
        };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.bun ];
          shellHook = ''
            echo "mattermost-exporter dev shell"
            echo "  bun install        # ローカル開発用 (node_modules)"
            echo "  bun src/index.ts   # run TUI"
            echo "  bun x tsc --noEmit # typecheck"
            echo ""
            echo "依存更新時: nix run github:nix-community/bun2nix -- -o bun.nix"
          '';
        };
      });
}
