import Foundation

struct DispatchCapabilities: Codable {
  var create: Bool?
  var attachments: Bool?
  var artifacts: Bool?
}
struct DispatchAgent: Codable, Identifiable {
  let id: String
  var description: String
  var capabilities: DispatchCapabilities?
}
struct DispatchChat: Codable, Identifiable {
  let id: String
  let agent: String
  let title: String
  let createdAt: String
  var sourceLabel: String?
  var activity: String?
  var addressable: Bool?
  var capabilities: DispatchCapabilities?
}
struct DispatchAttachment: Codable, Equatable {
  var name: String
  var mimeType: String
  var data: String
}
struct DispatchArtifact: Codable, Identifiable {
  let id: String
  let name: String
  let mimeType: String
}
struct DispatchMessage: Codable, Identifiable {
  let id: String
  let role: String
  let text: String
  var provenance: String?
  var thinking: String?
  var commentary: String?
  var error: String?
  var author: String?
  var attachments: [DispatchAttachment]?
  var artifacts: [DispatchArtifact]?
}
enum DispatchJSON: Codable {
  case object([String: DispatchJSON])
  case array([DispatchJSON])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(Double.self) {
      self = .number(v)
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode([String: DispatchJSON].self) {
      self = .object(v)
    } else {
      self = .array(try c.decode([DispatchJSON].self))
    }
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .object(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
  var text: String {
    if case .string(let text) = self { return text }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
  }
}
struct DispatchTool: Codable, Identifiable {
  let id: String
  let name: String
  let status: String
  var afterMessageId: String?
  var input: DispatchJSON?
  var output: DispatchJSON?
  var progress: DispatchJSON?
}
struct DispatchSnapshot: Codable {
  let chat: DispatchChat
  let messages: [DispatchMessage]
  let running: Bool
  let queued: Int
  let partial: String
  var partialThinking: String?
  var error: String?
  var readOnly: String?
  var readOnlyReason: String?
  var observation: String?
  var toolCalls: [DispatchTool]?
}
struct DispatchDraft: Codable, Equatable {
  var text = ""
  var attachments: [DispatchAttachment] = []
  var isEmpty: Bool {
    text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty
  }
}
struct DispatchPending: Codable {
  let requestId: String
  let draft: DispatchDraft
  var uncertain = false
}
struct DispatchCreation: Codable {
  let agent: String
  let key: String
}
