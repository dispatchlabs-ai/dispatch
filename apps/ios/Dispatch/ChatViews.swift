import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

private struct PauseTranscriptFollowingKey: EnvironmentKey {
  static let defaultValue: () -> Void = {}
}

extension EnvironmentValues {
  var pauseTranscriptFollowing: () -> Void {
    get { self[PauseTranscriptFollowingKey.self] }
    set { self[PauseTranscriptFollowingKey.self] = newValue }
  }
}

struct DispatchHomeView: View {
  @StateObject private var client = DispatchClient()
  @Environment(\.scenePhase) private var scenePhase
  @State private var path: [String] = []
  @State private var search = ""
  @State private var settings = false
  @State private var newChat = false
  private var chats: [DispatchChat] {
    client.chats.filter {
      search.isEmpty || $0.title.localizedCaseInsensitiveContains(search)
        || $0.agent.localizedCaseInsensitiveContains(search)
    }
  }
  var body: some View {
    NavigationStack(path: $path) {
      List {
        if client.origin.isEmpty {
          ContentUnavailableView {
            Label("Your conversations", systemImage: "bubble.left.and.bubble.right")
          } description: {
            Text("Use the HTTPS address of your Dispatch Web installation.")
          } actions: {
            Button("Connect to Dispatch") { settings = true }.buttonStyle(.borderedProminent)
          }.listRowSeparator(.hidden)
        } else {
          if !client.connected {
            DispatchConnectionStatus(client: client, signIn: { settings = true })
          }
          if let creation = client.pendingCreation {
            Button("Finish opening chat with \(creation.agent)", systemImage: "arrow.clockwise") {
              Task {
                do { path = [try await client.create(agent: creation.agent)] } catch {
                  client.error = error.localizedDescription
                }
              }
            }.disabled(client.creating || !client.connected)
          }
          ForEach(chats) { chat in
            NavigationLink(value: chat.id) {
              VStack(alignment: .leading, spacing: 6) {
                Text(chat.title).font(.headline).lineLimit(2)
                HStack {
                  Text(chat.agent).lineLimit(1)
                  Spacer()
                  if let activity = chat.activity, activity != "idle" {
                    Label(
                      activity.capitalized,
                      systemImage: activity == "working" ? "ellipsis" : "circle")
                  }
                }.font(.caption).foregroundStyle(.secondary)
              }.padding(.vertical, 5)
            }.accessibilityIdentifier("dispatch-chat-\(chat.id)")
          }
          if client.connected && chats.isEmpty {
            if search.isEmpty {
              ContentUnavailableView(
                "Start a conversation", systemImage: "bubble.left",
                description: Text("Choose an agent to start a new chat."))
            } else {
              ContentUnavailableView.search(text: search)
            }
          }
        }
      }
      .listStyle(.plain)
      .searchable(text: $search, prompt: "Search conversations or agents")
      .navigationTitle("Dispatch")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Settings", systemImage: "gearshape") { settings = true }.accessibilityIdentifier(
            "dispatch-settings")
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("New chat", systemImage: "square.and.pencil") { newChat = true }
            .disabled(!client.connected || client.agents.isEmpty).accessibilityIdentifier(
              "dispatch-new-chat")
        }
      }
      .refreshable {
        do { try await client.refresh() } catch { client.error = error.localizedDescription }
      }
      .navigationDestination(for: String.self) { id in
        DispatchConversationView(client: client, id: id, signIn: { settings = true })
      }
    }
    .onChange(of: scenePhase, initial: true) { _, phase in client.setActive(phase == .active) }
    .onChange(of: client.account) { _, _ in
      path = []
      search = ""
    }
    .onChange(of: path) { _, path in client.select(path.last) }
    .sheet(isPresented: $settings) { DispatchSettingsView(client: client) }
    .sheet(isPresented: $newChat) {
      DispatchAgentPicker(client: client) {
        path = [$0]
        newChat = false
      }
    }
  }
}

private struct DispatchConnectionStatus: View {
  @ObservedObject var client: DispatchClient
  let signIn: () -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if client.connecting {
        ProgressView("Connecting…")
      } else {
        Label(
          client.needsSignIn ? "Sign in to Dispatch" : "Offline",
          systemImage: "wifi.exclamationmark"
        ).font(.subheadline.weight(.medium))
        Text("Saved conversations and drafts are available. Work continues on the server.").font(
          .caption
        ).foregroundStyle(.secondary)
        Button(client.needsSignIn ? "Sign in" : "Reconnect") {
          client.needsSignIn ? signIn() : client.reconnect()
        }
      }
      if !client.error.isEmpty {
        Text(client.error).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
      }
    }.padding(.vertical, 8)
  }
}

private struct DispatchSettingsView: View {
  @ObservedObject var client: DispatchClient
  @Environment(\.dismiss) private var dismiss
  @State private var address = ""
  @State private var username = ""
  @State private var password = ""
  @State private var working = false
  @State private var problem = ""
  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("https://chat.example.com", text: $address)
            .textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("dispatch-address")
          TextField("Username", text: $username).textContentType(.username)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .accessibilityIdentifier("dispatch-username")
          SecureField("Password", text: $password).textContentType(.password)
            .accessibilityIdentifier("dispatch-password")
          Button {
            working = true
            problem = ""
            Task {
              do {
                try await client.connect(to: address, username: username, password: password)
                password = ""
                dismiss()
              } catch { problem = error.localizedDescription }
              working = false
            }
          } label: {
            if working { ProgressView("Connecting…") } else { Text("Connect to Dispatch") }
          }.disabled(
            working || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || !client.sending.isEmpty || client.creating
          ).accessibilityIdentifier("dispatch-connect")
        } header: {
          Text("Dispatch Web connection")
        } footer: {
          Text("Sign in with the account you use for Dispatch Web.")
        }
        if !problem.isEmpty { Text(problem).foregroundStyle(.red).textSelection(.enabled) }
        if !client.origin.isEmpty {
          Section {
            LabeledContent("Server", value: client.displayName)
            LabeledContent("Status", value: client.connected ? "Connected" : "Disconnected")
            Button("Sign out", role: .destructive) {
              Task {
                do {
                  try await client.signOut()
                  dismiss()
                } catch { problem = error.localizedDescription }
              }
            }.disabled(working || !client.sending.isEmpty || client.creating)
          }
        }

      }
      .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .onAppear {
      address = client.origin
      username = client.account?.username ?? ""
    }
  }
}

private struct DispatchAgentPicker: View {
  @ObservedObject var client: DispatchClient
  let selected: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var search = ""
  @State private var problem = ""
  var body: some View {
    NavigationStack {
      List {
        if !problem.isEmpty { Text(problem).foregroundStyle(.red) }
        ForEach(
          client.agents.filter {
            search.isEmpty || $0.id.localizedCaseInsensitiveContains(search)
              || $0.description.localizedCaseInsensitiveContains(search)
          }
        ) { agent in
          Button {
            Task {
              do { selected(try await client.create(agent: agent.id)) } catch {
                problem = error.localizedDescription
              }
            }
          } label: {
            HStack(spacing: 12) {
              Image(systemName: "person.crop.circle").font(.title2).foregroundStyle(.tint)
              VStack(alignment: .leading, spacing: 4) {
                Text(agent.id).font(.headline).foregroundStyle(.primary)
                if !agent.description.isEmpty {
                  Text(agent.description).font(.subheadline).foregroundStyle(.secondary)
                }
              }
              Spacer()
            }.padding(.vertical, 6)
          }.disabled(client.creating || agent.capabilities?.create == false)
            .accessibilityIdentifier("dispatch-agent-\(agent.id)")
        }
        if client.creating { ProgressView("Opening conversation…") }
      }
      .searchable(text: $search, prompt: "Find an agent")
      .navigationTitle("New conversation").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }
  }
}

private struct DispatchConversationView: View {
  @ObservedObject var client: DispatchClient
  let id: String
  let signIn: () -> Void
  @State private var followLatest = true
  @State private var readerScrolling = false
  @State private var scrollPosition = ScrollPosition(edge: .bottom)
  @State private var files = false
  @State private var photos = false
  @State private var photoSelection: [PhotosPickerItem] = []
  @State private var preparing = false
  @State private var expanded = false
  @State private var preview: URL?
  @State private var stopAppeared = Date.distantPast
  @FocusState private var typing: Bool
  private var snapshot: DispatchSnapshot? { client.snapshot(id) }
  private var chat: DispatchChat? { snapshot?.chat ?? client.chats.first { $0.id == id } }
  private var draft: DispatchDraft { client.draft(id) }
  private var text: Binding<String> {
    Binding(
      get: { draft.text },
      set: {
        var d = draft
        d.text = $0
        client.updateDraft(id, d)
      })
  }
  private var showStop: Bool {
    snapshot?.running == true && draft.isEmpty && client.pending(id) == nil
  }
  private var readOnly: Bool { snapshot?.readOnly != nil || chat?.addressable == false }
  private var canSend: Bool {
    client.connected && !readOnly && !draft.isEmpty && client.pending(id) == nil
      && !client.sending.contains(id) && !preparing
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        if let snapshot {
          if snapshot.messages.isEmpty && !snapshot.running {
            ContentUnavailableView(
              "Chat with \(snapshot.chat.agent)", systemImage: "bubble.left.and.bubble.right",
              description: Text("Send a message to get started."))
          }
          ForEach(
            snapshot.messages.filter { $0.provenance != "runtime" && $0.role != "toolResult" }
          ) { message in
            DispatchMessageView(
              message: message, openAttachment: open,
              openArtifact: { artifact in
                Task {
                  do { preview = try await client.artifact(artifact, chat: id) } catch {
                    client.error = error.localizedDescription
                  }
                }
              })
            let tools = (snapshot.toolCalls ?? []).filter { $0.afterMessageId == message.id }
            if !tools.isEmpty { ToolActivityView(tools: tools) }
          }
          let unplaced = (snapshot.toolCalls ?? []).filter { tool in
            !snapshot.messages.contains { $0.id == tool.afterMessageId }
          }
          if !unplaced.isEmpty { ToolActivityView(tools: unplaced) }
          if let thinking = snapshot.partialThinking, !thinking.isEmpty {
            DispatchThinkingView(text: thinking)
          }
          if !snapshot.partial.isEmpty { MarkdownText(text: snapshot.partial) }
          if snapshot.running {
            HStack(spacing: 8) {
              ProgressView().controlSize(.small)
              Text(snapshot.queued > 0 ? "Working · \(snapshot.queued) pending" : "Working…").font(
                .subheadline
              ).foregroundStyle(.secondary)
            }
          }
          if let reason = snapshot.readOnlyReason ?? snapshot.observation {
            Text(reason).font(.subheadline).foregroundStyle(.secondary)
          }
          if let error = snapshot.error, !error.isEmpty {
            Label(error, systemImage: "exclamationmark.circle").font(.subheadline).textSelection(
              .enabled)
          }
        } else {
          ProgressView("Opening conversation…").frame(maxWidth: .infinity).padding(.top, 40)
        }
        if !client.connected {
          DispatchConnectionStatus(client: client, signIn: signIn)
        } else if !client.error.isEmpty {
          Label(client.error, systemImage: "exclamationmark.circle").font(.caption).textSelection(
            .enabled)
        }
        if client.pending(id) != nil && !client.sending.contains(id) {
          VStack(alignment: .leading, spacing: 6) {
            Text("Delivery hasn’t been confirmed. Your message is saved.").font(.subheadline)
            Button("Retry the same message", systemImage: "arrow.clockwise") {
              Task { await client.send(id) }
            }
            .disabled(!client.connected || client.sending.contains(id)).accessibilityIdentifier(
              "dispatch-retry")
          }
        }
      }.padding(.horizontal, 20).padding(.vertical, 20)
    }
    .scrollPosition($scrollPosition)
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    .defaultScrollAnchor(followLatest ? .bottom : nil, for: .sizeChanges)
    .defaultScrollAnchor(.top, for: .alignment)
    .scrollDismissesKeyboard(.interactively)
    .onScrollPhaseChange { _, phase in
      readerScrolling = phase == .interacting || phase == .decelerating
    }
    .onScrollGeometryChange(for: CGFloat.self) { g in
      max(
        0,
        g.contentSize.height + g.contentInsets.bottom - g.contentOffset.y - g.containerSize.height)
    } action: { _, distance in
      if readerScrolling { followLatest = distance < 80 }
    }
    .environment(\.pauseTranscriptFollowing, { followLatest = false })
    .overlay(alignment: .bottom) {
      if !followLatest {
        Button("Latest", systemImage: "arrow.down") {
          followLatest = true
          scrollPosition.scrollTo(edge: .bottom)
        }
        .buttonStyle(.bordered).background(.regularMaterial, in: Capsule()).padding(8)
      }
    }
    .navigationTitle(chat?.title ?? "Conversation").navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) {
        VStack(spacing: 2) {
          Text(chat?.title ?? "Conversation").font(.headline).lineLimit(1)
          Text(chat?.agent ?? "Dispatch").font(.caption).foregroundStyle(.secondary)
        }
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) { composer }
    .onChange(of: showStop) { _, shown in if shown { stopAppeared = .now } }
    .onChange(of: typing) { _, _ in if followLatest { scrollPosition.scrollTo(edge: .bottom) } }
    .onAppear { client.select(id) }
    .fileImporter(isPresented: $files, allowedContentTypes: [.item], allowsMultipleSelection: true)
    { result in
      do {
        for url in try result.get() {
          let access = url.startAccessingSecurityScopedResource()
          defer { if access { url.stopAccessingSecurityScopedResource() } }
          let data = try Data(contentsOf: url)
          try append(
            data, name: url.lastPathComponent,
            mime: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
              ?? "application/octet-stream")
        }
      } catch { client.error = error.localizedDescription }
    }
    .onChange(of: photoSelection) { _, items in
      guard !items.isEmpty else { return }
      preparing = true
      Task {
        defer {
          photoSelection = []
          preparing = false
        }
        for item in items {
          do {
            guard let bytes = try await item.loadTransferable(type: Data.self) else {
              throw DispatchFailure(message: "This photo could not be loaded.")
            }
            let type = item.supportedContentTypes.first
            if let mime = type?.preferredMIMEType,
              ["image/jpeg", "image/png", "image/webp"].contains(mime)
            {
              try append(
                bytes,
                name: "Photo-\(UUID().uuidString).\(type?.preferredFilenameExtension ?? "jpg")",
                mime: mime)
            } else if let image = UIImage(data: bytes), let converted = image.pngData() {
              try append(converted, name: "Photo-\(UUID().uuidString).png", mime: "image/png")
            } else {
              throw DispatchFailure(message: "This photo could not be opened.")
            }
          } catch { client.error = error.localizedDescription }
        }
      }
    }
    .photosPicker(
      isPresented: $photos, selection: $photoSelection, selectionBehavior: .ordered,
      matching: .images, preferredItemEncoding: .current
    )
    .quickLookPreview($preview)
    .sheet(isPresented: $expanded) {
      NavigationStack {
        TextEditor(text: text).padding().navigationTitle("Message").navigationBarTitleDisplayMode(
          .inline
        )
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Done") { expanded = false } }
          ToolbarItem(placement: .confirmationAction) {
            Button("Send") {
              expanded = false
              send()
            }.disabled(!canSend)
          }
        }
      }
    }
  }
  private var composer: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !draft.attachments.isEmpty {
        ScrollView(.horizontal) {
          HStack {
            ForEach(Array(draft.attachments.enumerated()), id: \.offset) { index, file in
              HStack {
                Button {
                  open(file)
                } label: {
                  Label(file.name, systemImage: file.mimeType.hasPrefix("image/") ? "photo" : "doc")
                    .lineLimit(1)
                }
                Button("Remove \(file.name)", systemImage: "xmark.circle.fill") {
                  var d = draft
                  d.attachments.remove(at: index)
                  client.updateDraft(id, d)
                }.labelStyle(.iconOnly).disabled(client.pending(id) != nil)
              }.font(.caption).padding(10).background(
                .quaternary, in: RoundedRectangle(cornerRadius: 10))
            }
          }
        }
      }
      if !readOnly {
        TextField("Message \(chat?.agent ?? "agent")", text: text, axis: .vertical)
          .lineLimit(1...6).focused($typing).disabled(client.pending(id) != nil)
          .accessibilityIdentifier("dispatch-message")
        HStack {
          Menu {
            Button("Photo Library", systemImage: "photo") { photos = true }
            Button("Choose Files", systemImage: "doc") { files = true }
          } label: {
            Image(systemName: "plus").frame(width: 44, height: 44)
          }
          .accessibilityLabel("Add attachment").disabled(
            preparing || client.pending(id) != nil || chat?.capabilities?.attachments == false)
          if preparing { ProgressView().controlSize(.small) }
          Spacer()
          Button("Expand message", systemImage: "arrow.up.left.and.arrow.down.right") {
            typing = false
            expanded = true
          }
          .labelStyle(.iconOnly).frame(width: 44, height: 44).disabled(client.pending(id) != nil)
          if showStop {
            Button {
              guard Date().timeIntervalSince(stopAppeared) >= 0.5 else { return }
              Task { await client.stop(id) }
            } label: {
              Image(systemName: "stop.fill").frame(width: 44, height: 44).foregroundStyle(
                Color(.systemBackground)
              ).background(Color.primary, in: Circle())
            }
            .accessibilityLabel("Stop response").accessibilityIdentifier("dispatch-stop")
          } else {
            Button(action: send) {
              Group {
                if client.sending.contains(id) {
                  ProgressView().tint(.white)
                } else {
                  Image(systemName: "arrow.up").fontWeight(.semibold)
                }
              }
              .frame(width: 44, height: 44).foregroundStyle(canSend ? Color.white : Color.secondary)
              .background(canSend ? Color.accentColor : Color(.tertiarySystemFill), in: Circle())
            }.disabled(!canSend).accessibilityLabel("Send message").accessibilityIdentifier(
              "dispatch-send"
            ).keyboardShortcut(.return, modifiers: .command)
          }
        }
      }
    }.padding(.horizontal, 16).padding(.vertical, 10).background(.bar)
  }
  private func send() {
    followLatest = true
    Task { await client.send(id) }
  }
  private func append(_ data: Data, name: String, mime: String) throws {
    guard
      ["image/jpeg", "image/png", "image/webp"].contains(mime)
        || String(data: data, encoding: .utf8) != nil
    else {
      throw DispatchFailure(
        message:
          "Dispatch supports images and UTF-8 text files. \(name) is not supported by the server.")
    }
    let nativeMime = mime.hasPrefix("image/") ? mime : "text/plain"
    var d = draft
    d.attachments.append(
      DispatchAttachment(name: name, mimeType: nativeMime, data: data.base64EncodedString()))
    client.updateDraft(id, d)
  }
  private func open(_ file: DispatchAttachment) {
    do {
      guard let data = Data(base64Encoded: file.data) else {
        throw DispatchFailure(message: "This attachment could not be opened.")
      }
      preview = try DispatchClient.previewFile(data, name: file.name)
    } catch { client.error = error.localizedDescription }
  }
}

private struct DispatchThinkingView: View {
  let text: String
  @State private var expanded = false
  var body: some View {
    DisclosureGroup("Thinking", isExpanded: $expanded) { MarkdownText(text: text).padding(.top, 8) }
      .font(.subheadline).foregroundStyle(.secondary)
  }
}

private struct DispatchMessageView: View {
  let message: DispatchMessage
  let openAttachment: (DispatchAttachment) -> Void
  let openArtifact: (DispatchArtifact) -> Void
  var body: some View {
    VStack(alignment: message.role == "user" ? .trailing : .leading, spacing: 10) {
      if let thinking = message.thinking, !thinking.isEmpty { DispatchThinkingView(text: thinking) }
      if let commentary = message.commentary, !commentary.isEmpty {
        MarkdownText(text: commentary).foregroundStyle(.secondary)
      }
      if !message.text.isEmpty {
        if message.role == "user" {
          Text(message.text).textSelection(.enabled).padding(14).background(
            Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
        } else {
          MarkdownText(text: message.text)
        }
      }
      if let error = message.error, !error.isEmpty {
        Label(error, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(
          .secondary
        ).textSelection(.enabled)
      }
      ForEach(Array((message.attachments ?? []).enumerated()), id: \.offset) { _, file in
        Button {
          openAttachment(file)
        } label: {
          if file.mimeType.hasPrefix("image/"), let data = Data(base64Encoded: file.data),
            let image = UIImage(data: data)
          {
            Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 220).clipShape(
              RoundedRectangle(cornerRadius: 12))
          } else {
            Label(file.name, systemImage: "doc")
          }
        }.accessibilityLabel("Open \(file.name)")
      }
      ForEach(message.artifacts ?? []) { artifact in
        Button {
          openArtifact(artifact)
        } label: {
          Label(artifact.name, systemImage: "arrow.down.doc")
        }
      }
      if message.role != "user", !message.text.isEmpty {
        ShareLink(item: message.text) {
          Label("Share response", systemImage: "square.and.arrow.up")
        }.labelStyle(.iconOnly).foregroundStyle(.secondary)
          .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
          }
      }
    }.frame(maxWidth: .infinity, alignment: message.role == "user" ? .trailing : .leading)
      .accessibilityElement(children: .contain)
      .accessibilityLabel(message.role == "user" ? message.author ?? "You" : "Assistant")
  }
}
