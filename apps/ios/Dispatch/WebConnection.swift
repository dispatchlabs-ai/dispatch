import CryptoKit
import Foundation
import Security

struct WebAccount: Codable, Equatable {
  let origin: String
  let username: String

  init(address: String, username: String) throws {
    let address = address.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var url = URLComponents(string: address),
      let host = url.host, !host.isEmpty,
      let scheme = url.scheme?.lowercased(),
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      url.path.isEmpty || url.path == "/"
    else { throw Self.invalidAddress }
    #if targetEnvironment(simulator)
      let loopback =
        scheme == "http" && ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host.lowercased())
    #else
      let loopback = false
    #endif
    guard scheme == "https" || loopback else { throw Self.invalidAddress }
    url.host = host.lowercased()
    url.scheme = scheme
    url.path = ""
    if (scheme == "https" && url.port == 443) || (scheme == "http" && url.port == 80) {
      url.port = nil
    }
    guard let normalized = url.url?.absoluteString else { throw Self.invalidAddress }
    self.origin = normalized
    self.username = username
  }

  private static let invalidAddress = DispatchFailure(
    message: "Enter the HTTPS address of your Dispatch Web installation, without a path.")
  var storageKey: String {
    SHA256.hash(data: Data((origin + "\0" + username).utf8)).map { String(format: "%02x", $0) }
      .joined()
  }
}

struct DispatchFailure: LocalizedError {
  let message: String
  var status: Int? = nil
  var errorDescription: String? { message }
}

private struct Credential: Codable {
  let header: String
  let value: String
}

private enum Keychain {
  private static func query(_ account: WebAccount) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "Dispatch") + ".web",
      kSecAttrAccount as String: account.storageKey,
    ]
  }

  static func read(_ account: WebAccount) throws -> Credential? {
    var query = query(account)
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw failure(status) }
    return try JSONDecoder().decode(Credential.self, from: data)
  }

  static func save(_ credential: Credential, for account: WebAccount) throws {
    let values: [String: Any] = [
      kSecValueData as String: try JSONEncoder().encode(credential),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let query = query(account)
    var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(query.merging(values) { _, new in new } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw failure(status) }
  }

  static func clear(_ account: WebAccount) throws {
    let status = SecItemDelete(query(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw failure(status) }
  }

  private static func failure(_ status: OSStatus) -> DispatchFailure {
    DispatchFailure(message: "Could not access the iPhone Keychain (\(status)).")
  }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

/// Each connection is bound to one origin and account, including its streams and credential renewals.
@MainActor final class WebConnection {
  let account: WebAccount
  private var credential: Credential?
  private var remembersRenewals = false
  private let session: URLSession

  init(_ account: WebAccount) throws {
    self.account = account
    self.credential = try Keychain.read(account)
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCredentialStorage = nil
    config.urlCache = nil
    session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
  }

  func remember() throws {
    if let credential { try Keychain.save(credential, for: account) }
    remembersRenewals = true
  }

  func close() {
    remembersRenewals = false
    session.invalidateAndCancel()
  }

  func login(password: String) async throws {
    var form = URLComponents()
    form.queryItems = [
      URLQueryItem(name: "username", value: account.username),
      URLQueryItem(name: "password", value: password),
    ]
    let encoded = (form.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
    var login = try request("/login", method: "POST", data: Data(encoded.utf8))
    login.setValue(nil, forHTTPHeaderField: "Cookie")
    login.setValue(nil, forHTTPHeaderField: "Authorization")
    login.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    let (data, response) = try await session.data(for: login)
    guard let http = response as? HTTPURLResponse else {
      throw DispatchFailure(message: "Could not sign in.")
    }
    if http.statusCode == 303, let issued = cookie(from: http) {
      credential = issued
    } else if http.statusCode == 401,
      http.value(forHTTPHeaderField: "WWW-Authenticate")?.lowercased().hasPrefix("basic") == true
    {
      let authorization = Data((account.username + ":" + password).utf8).base64EncodedString()
      credential = Credential(header: "Authorization", value: "Basic " + authorization)
    } else {
      try check(response, data: data)
      throw DispatchFailure(message: "This server did not issue a Dispatch Web sign-in session.")
    }
  }

  func logout() async throws {
    if credential?.header == "Cookie" {
      let (data, response) = try await session.data(
        for: request("/logout", method: "POST", data: Data()))
      if let http = response as? HTTPURLResponse, ![303, 401].contains(http.statusCode) {
        try check(http, data: data)
      }
    }
    try Keychain.clear(account)
    credential = nil
    close()
  }

  func catalog() async throws -> ([DispatchAgent], [DispatchChat]) {
    async let agents: [DispatchAgent] = get("/api/agents")
    async let chats: [DispatchChat] = get("/api/chats")
    return try await (agents, chats)
  }

  private func get<T: Decodable>(_ path: String) async throws -> T {
    try JSONDecoder().decode(T.self, from: await data(path))
  }

  func data(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
    let (data, response) = try await session.data(for: request(path, method: method, data: body))
    try Task.checkCancellation()
    try check(response, data: data)
    return data
  }

  func snapshots<T: Decodable>(_ path: String, receive: (T) throws -> Void) async throws {
    var request = try request(path)
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    let (bytes, response) = try await session.bytes(for: request)
    try Task.checkCancellation()
    try check(response)
    guard response.mimeType == "text/event-stream" else {
      throw DispatchFailure(message: "Expected a Dispatch Web event stream.")
    }
    var event = ""
    var payload: [String] = []
    // AsyncBytes.lines drops empty lines, which delimit events in SSE.
    var lineBytes = Data()
    for try await byte in bytes {
      try Task.checkCancellation()
      guard byte == 10 else {
        lineBytes.append(byte)
        continue
      }
      if lineBytes.last == 13 { lineBytes.removeLast() }
      let line = String(decoding: lineBytes, as: UTF8.self)
      lineBytes.removeAll(keepingCapacity: true)
      if line.isEmpty {
        if event == "failure" {
          throw DispatchFailure(message: "Live updates disconnected. Reconnecting…")
        }
        if event == "snapshot", !payload.isEmpty {
          try receive(
            JSONDecoder().decode(T.self, from: Data(payload.joined(separator: "\n").utf8)))
        }
        event = ""
        payload.removeAll(keepingCapacity: true)
      } else if line.hasPrefix("event:") {
        event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
      } else if line.hasPrefix("data:") {
        let value = line.dropFirst(5)
        payload.append(String(value.first == " " ? value.dropFirst() : value))
      }
    }
    throw DispatchFailure(message: "Live updates disconnected. Reconnecting…")
  }

  private func request(_ path: String, method: String = "GET", data: Data? = nil) throws
    -> URLRequest
  {
    guard let url = URL(string: account.origin + path) else {
      throw DispatchFailure(message: "Invalid Dispatch Web address.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = data
    request.setValue(account.origin, forHTTPHeaderField: "Origin")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if data != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    if let credential { request.setValue(credential.value, forHTTPHeaderField: credential.header) }
    return request
  }

  private func cookie(from response: HTTPURLResponse) -> Credential? {
    guard let url = response.url else { return nil }
    let headers = response.allHeaderFields.reduce(into: [String: String]()) {
      $0[String(describing: $1.key)] = String(describing: $1.value)
    }
    guard
      let cookie = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url).first(where: {
        $0.name == "__Host-dispatch_session" && !$0.value.isEmpty && $0.isSecure
      })
    else { return nil }
    return Credential(header: "Cookie", value: cookie.name + "=" + cookie.value)
  }

  private func check(_ response: URLResponse, data: Data = Data()) throws {
    guard let http = response as? HTTPURLResponse else {
      throw DispatchFailure(message: "Dispatch Web returned an unreadable response.")
    }
    guard (200..<300).contains(http.statusCode) else {
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      let fallback =
        http.statusCode == 401
        ? "Sign in with your Dispatch Web username and password."
        : "Dispatch Web returned HTTP \(http.statusCode)."
      throw DispatchFailure(
        message: value?["error"] as? String ?? fallback, status: http.statusCode)
    }
    if credential?.header == "Cookie", let renewed = cookie(from: http) {
      if remembersRenewals { try Keychain.save(renewed, for: account) }
      credential = renewed
    }
  }
}
