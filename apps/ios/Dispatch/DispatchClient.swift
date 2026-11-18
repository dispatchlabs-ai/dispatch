import Foundation
import SwiftUI

private struct ChatCache: Codable {
  var agents: [DispatchAgent] = []
  var chats: [DispatchChat] = []
  var snapshots: [String: DispatchSnapshot] = [:]
  var drafts: [String: DispatchDraft] = [:]
  var pending: [String: DispatchPending] = [:]
  var creation: DispatchCreation?

  private static func url(for account: WebAccount) -> URL {
    URL.applicationSupportDirectory.appending(path: "Dispatch/\(account.storageKey).json")
  }

  static func load(for account: WebAccount) throws -> Self {
    let file = url(for: account)
    guard FileManager.default.fileExists(atPath: file.path) else { return Self() }
    return try JSONDecoder().decode(Self.self, from: Data(contentsOf: file))
  }

  func save(for account: WebAccount) throws {
    let file = Self.url(for: account)
    try FileManager.default.createDirectory(
      at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(self).write(
      to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
}

@MainActor final class DispatchClient: ObservableObject {
  @Published private(set) var account: WebAccount?
  @Published private(set) var connected = false
  @Published private(set) var connecting = false
  @Published private(set) var needsSignIn = false
  @Published private var cache = ChatCache()
  @Published var error = ""
  @Published private(set) var sending: Set<String> = []
  @Published private(set) var creating = false

  private var connection: WebConnection?
  private var navigationTask: Task<Void, Never>?
  private var conversationTask: Task<Void, Never>?
  private var draftSaveTask: Task<Void, Never>?
  private var active = false
  private var changingAccount = false
  private var selected: String?
  private let savedAccountKey = "dispatch-web-account"

  var origin: String { account?.origin ?? "" }
  var agents: [DispatchAgent] { cache.agents }
  var chats: [DispatchChat] { cache.chats }
  var pendingCreation: DispatchCreation? { cache.creation }
  var displayName: String { URL(string: origin)?.host ?? "Dispatch" }

  init() {
    guard let data = UserDefaults.standard.data(forKey: savedAccountKey) else { return }
    do {
      let saved = try JSONDecoder().decode(WebAccount.self, from: data)
      let account = try WebAccount(address: saved.origin, username: saved.username)
      self.account = account
      cache = try ChatCache.load(for: account)
      let restored = try WebConnection(account)
      connection = restored
      try restored.remember()
    } catch { self.error = error.localizedDescription }
  }

  func connect(to address: String, username: String, password: String) async throws {
    guard !changingAccount, sending.isEmpty, !creating else {
      throw DispatchFailure(
        message: "Wait for the current request to finish before changing connections.")
    }
    let account = try WebAccount(address: address, username: username)
    flushDraft()
    changingAccount = true
    connecting = true
    stopObserving()
    defer {
      changingAccount = false
      connecting = false
      startObserving()
    }
    let candidate = try WebConnection(account)
    do {
      if !password.isEmpty { try await candidate.login(password: password) }
      let (agents, chats) = try await candidate.catalog()
      var next = self.account == account ? cache : try ChatCache.load(for: account)
      next.agents = agents
      next.chats = chats
      try next.save(for: account)
      try candidate.remember()
      let saved = try JSONEncoder().encode(account)
      connection?.close()
      if self.account != account { selected = nil }
      connection = candidate
      self.account = account
      cache = next
      UserDefaults.standard.set(saved, forKey: savedAccountKey)
      connected = true
      needsSignIn = false
      error = ""
    } catch {
      candidate.close()
      throw error
    }
  }

  func signOut() async throws {
    guard !changingAccount, sending.isEmpty, !creating, let connection else {
      throw DispatchFailure(message: "Wait for the current request to finish before signing out.")
    }
    changingAccount = true
    stopObserving()
    defer {
      changingAccount = false
      startObserving()
    }
    flushDraft()
    try await connection.logout()
    UserDefaults.standard.removeObject(forKey: savedAccountKey)
    self.connection = nil
    selected = nil
    account = nil
    cache = ChatCache()
    connected = false
    connecting = false
    needsSignIn = false
    error = ""
  }

  private func persist() throws {
    guard let account else { throw DispatchFailure(message: "Connect to Dispatch first.") }
    try cache.save(for: account)
  }

  private func saveObservation() {
    do { try persist() } catch {
      self.error = "Could not save the offline copy: \(error.localizedDescription)"
    }
  }

  private func flushDraft() {
    guard draftSaveTask != nil else { return }
    draftSaveTask?.cancel()
    draftSaveTask = nil
    saveObservation()
  }

  func setActive(_ value: Bool) {
    active = value
    if value {
      startObserving()
    } else {
      flushDraft()
      stopObserving()
    }
  }

  private func stopObserving() {
    navigationTask?.cancel()
    navigationTask = nil
    conversationTask?.cancel()
    conversationTask = nil
  }

  func reconnect() {
    error = ""
    needsSignIn = false
    stopObserving()
    startObserving()
  }

  func refresh() async throws {
    guard let connection, !changingAccount else { return }
    let (agents, chats) = try await connection.catalog()
    try Task.checkCancellation()
    guard self.connection === connection else { throw CancellationError() }
    cache.agents = agents
    cache.chats = chats
    connected = true
    needsSignIn = false
    error = ""
    saveObservation()
  }

  private func reportConnectionError(_ error: Error) {
    connected = false
    needsSignIn = (error as? DispatchFailure)?.status == 401
    self.error = error.localizedDescription
  }

  private func startObserving() {
    guard active, !changingAccount, !needsSignIn, let connection, navigationTask == nil else {
      return
    }
    navigationTask = Task {
      while !Task.isCancelled {
        do {
          connecting = !connected
          try await refresh()
          connecting = false
          try await connection.snapshots("/api/sidebar/events") { (update: SidebarUpdate) in
            cache.agents = update.agents
            cache.chats = update.chats
            connected = true
            saveObservation()
          }
        } catch {
          guard !Task.isCancelled, self.connection === connection else { return }
          connecting = false
          // Older compatible Web installations provide a catalog without sidebar events.
          if (error as? DispatchFailure)?.status != 404 { reportConnectionError(error) }
          if needsSignIn { return }
        }
        do { try await Task.sleep(for: .seconds(2)) } catch { return }
      }
    }
    watchSelected()
  }

  private struct SidebarUpdate: Decodable {
    let agents: [DispatchAgent]
    let chats: [DispatchChat]
  }

  func select(_ id: String?) {
    guard id != selected else { return }
    flushDraft()
    selected = id
    conversationTask?.cancel()
    conversationTask = nil
    watchSelected()
  }

  private func watchSelected() {
    guard active, !changingAccount, !needsSignIn, let id = selected, let connection,
      conversationTask == nil
    else { return }
    conversationTask = Task {
      while !Task.isCancelled {
        do {
          try await connection.snapshots("/api/chats/\(Self.segment(id))/events") {
            (value: DispatchSnapshot) in
            guard value.chat.id == id else { return }
            cache.snapshots[id] = value
            connected = true
            error = ""
            saveObservation()
          }
        } catch {
          guard !Task.isCancelled, self.connection === connection else { return }
          reportConnectionError(error)
          if needsSignIn { return }
        }
        do { try await Task.sleep(for: .seconds(2)) } catch { return }
      }
    }
  }

  private static func segment(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
  }

  private func post(_ path: String, body: Data) async throws -> Data {
    guard !changingAccount, let connection else {
      throw DispatchFailure(message: "Connect to Dispatch first.")
    }
    do {
      let data = try await connection.data(path, method: "POST", body: body)
      guard self.connection === connection else { throw CancellationError() }
      return data
    } catch {
      if self.connection === connection, (error as? DispatchFailure)?.status == 401 {
        reportConnectionError(error)
      }
      throw error
    }
  }

  func snapshot(_ id: String) -> DispatchSnapshot? { cache.snapshots[id] }
  func draft(_ id: String) -> DispatchDraft { cache.drafts[id] ?? DispatchDraft() }
  func pending(_ id: String) -> DispatchPending? { cache.pending[id] }
  func updateDraft(_ id: String, _ value: DispatchDraft) {
    guard cache.pending[id] == nil else { return }
    cache.drafts[id] = value
    draftSaveTask?.cancel()
    draftSaveTask = Task { [weak self] in
      do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
      self?.flushDraft()
    }
  }
  func create(agent: String) async throws -> String {
    guard !changingAccount, connected else {
      throw DispatchFailure(message: "Connect to Dispatch first.")
    }
    guard !creating else {
      throw DispatchFailure(message: "A conversation is already being created.")
    }
    if let existing = cache.creation, existing.agent != agent {
      throw DispatchFailure(message: "Resolve the previous new-conversation request first.")
    }
    creating = true
    defer { creating = false }
    let retrying = cache.creation != nil
    let creation =
      cache.creation ?? DispatchCreation(agent: agent, key: UUID().uuidString.lowercased())
    cache.creation = creation
    try persist()
    let data: Data
    do { data = try await post("/api/chats", body: JSONEncoder().encode(creation)) } catch {
      if !retrying, let status = (error as? DispatchFailure)?.status, (400..<500).contains(status) {
        cache.creation = nil
        saveObservation()
      }
      throw error
    }
    let chat = try JSONDecoder().decode(DispatchChat.self, from: data)
    cache.creation = nil
    if !cache.chats.contains(where: { $0.id == chat.id }) { cache.chats.insert(chat, at: 0) }
    try persist()
    return chat.id
  }
  func send(_ id: String) async {
    guard !changingAccount, !sending.contains(id), connected else { return }
    sending.insert(id)
    defer { sending.remove(id) }
    var pending =
      cache.pending[id]
      ?? DispatchPending(requestId: UUID().uuidString.lowercased(), draft: draft(id))
    guard !pending.draft.isEmpty else { return }
    let hadUncertainAttempt = pending.uncertain
    do {
      // Save the immutable payload before starting an operation whose response may be lost.
      pending.uncertain = true
      cache.pending[id] = pending
      try persist()
      struct Input: Encodable {
        let requestId: String
        let text: String
        let attachments: [DispatchAttachment]
      }
      let input = Input(
        requestId: pending.requestId, text: pending.draft.text,
        attachments: pending.draft.attachments)
      let data = try await post(
        "/api/chats/\(Self.segment(id))/messages", body: JSONEncoder().encode(input))
      struct Receipt: Decodable { let submissionId: Int }
      _ = try JSONDecoder().decode(Receipt.self, from: data)
      cache.pending.removeValue(forKey: id)
      if cache.drafts[id] == pending.draft { cache.drafts[id] = DispatchDraft() }
      try persist()
      error = ""
    } catch {
      if !hadUncertainAttempt, let status = (error as? DispatchFailure)?.status,
        (400..<500).contains(status)
      {
        cache.pending.removeValue(forKey: id)
        saveObservation()
      }
      self.error = error.localizedDescription
    }
  }
  func stop(_ id: String) async {
    do { _ = try await post("/api/chats/\(Self.segment(id))/stop", body: Data("{}".utf8)) } catch {
      self.error = error.localizedDescription
    }
  }

  func artifact(_ artifact: DispatchArtifact, chat: String) async throws -> URL {
    guard let connection else { throw DispatchFailure(message: "Connect to Dispatch first.") }
    let path = "/api/chats/\(Self.segment(chat))/artifacts/\(Self.segment(artifact.id))"
    let data = try await connection.data(path)
    guard self.connection === connection else { throw CancellationError() }
    return try Self.previewFile(data, name: artifact.name)
  }

  static func previewFile(_ data: Data, name: String) throws -> URL {
    let directory = URL.temporaryDirectory.appending(
      path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let component = (name as NSString).lastPathComponent
    let filename = ["", ".", "..", "/"].contains(component) ? "Attachment" : component
    let url = directory.appending(component: filename)
    try data.write(
      to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    return url
  }
}
