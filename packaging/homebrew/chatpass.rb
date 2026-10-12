# Homebrew formula template. After publishing to npm:
#   1. Put this in a tap repo (e.g. github.com/Hemanshu/homebrew-tap/Formula/chatpass.rb)
#   2. Fill in sha256: curl -sL https://registry.npmjs.org/chatpass/-/chatpass-0.2.0.tgz | shasum -a 256
#   3. Users install with: brew install hemanshu/tap/chatpass
class Chatpass < Formula
  desc "Share secrets with AI agents via one-time, end-to-end encrypted links"
  homepage "https://github.com/Hemanshu/chatpass"
  url "https://registry.npmjs.org/chatpass/-/chatpass-0.2.0.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/chatpass --version")
  end
end
