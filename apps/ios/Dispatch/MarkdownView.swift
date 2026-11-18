import SwiftUI

struct MarkdownBlock: Identifiable {
  enum Kind { case paragraph, heading, code, quote, listItem, table, rule }
  let id: String
  let kind: Kind
  var text = AttributedString()
  var label = ""
  var level = 0
  var children: [MarkdownBlock] = []
  var rows: [[AttributedString]] = []
}

// Foundation parses Markdown; we only adapt its block hierarchy to our native views.
struct MarkdownDocument {
  let blocks: [MarkdownBlock]
  private final class Node {
    let id: Int
    let kind: PresentationIntent.Kind
    var text = AttributedString()
    var children: [Node] = []
    var checkbox: (label: String, count: Int)?
    init(_ id: Int, _ kind: PresentationIntent.Kind) {
      self.id = id
      self.kind = kind
    }
  }
  init(_ source: String) {
    let parsed =
      (try? AttributedString(
        markdown: source,
        options: .init(
          failurePolicy: .returnPartiallyParsedIfPossible, appliesSourcePositionAttributes: true)))
      ?? AttributedString(source)
    let lines = source.components(separatedBy: .newlines)
    let root = Node(0, .paragraph)
    var nodes: [Int: Node] = [:]
    for run in parsed.runs {
      var parent = root
      for intent in (run.presentationIntent?.components ?? []).reversed() {
        if let node = nodes[intent.identity] {
          parent = node
        } else {
          let node = Node(intent.identity, intent.kind)
          nodes[intent.identity] = node
          parent.children.append(node)
          parent = node
        }
      }
      if parent.text.characters.isEmpty, run.inlinePresentationIntent == nil,
        let position = run.markdownSourcePosition,
        lines.indices.contains(position.startLine - 1)
      {
        let raw = String(
          decoding: lines[position.startLine - 1].utf8.dropFirst(position.startColumn - 1).prefix(
            4), as: UTF8.self
        ).lowercased()
        if ["[x]", "[x] ", "[x]\t", "[ ]", "[ ] ", "[ ]\t"].contains(raw) {
          parent.checkbox = (raw.hasPrefix("[x]") ? "☑" : "☐", raw.count)
        }
      }
      if parent === root {
        let node = Node(-root.children.count - 1, .paragraph)
        root.children.append(node)
        parent = node
      }
      var text = AttributedString(parsed[run.range])
      text.presentationIntent = nil
      if run.inlinePresentationIntent?.contains(.code) == true {
        text.font = .system(.body, design: .monospaced)
        text.backgroundColor = Color(.tertiarySystemFill)
      }
      if run.inlinePresentationIntent?.contains(.strikethrough) == true {
        text.strikethroughStyle = .single
      }
      if let url = run.link { text.link = Self.externalLink(url) }
      if let image = run.imageURL {
        text = AttributedString("Image: " + String(text.characters))
        text.link = Self.externalLink(image)
      }
      parent.text += text
    }
    blocks = Self.blocks(root)
  }
  private static func externalLink(_ url: URL) -> URL? {
    ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") ? url : nil
  }
  private static func blocks(_ parent: Node) -> [MarkdownBlock] {
    parent.children.flatMap { node -> [MarkdownBlock] in
      var block = MarkdownBlock(id: "b.\(node.id)", kind: .paragraph, text: node.text)
      switch node.kind {
      case .orderedList, .unorderedList: return blocks(node)
      case .header(let level):
        block = MarkdownBlock(id: block.id, kind: .heading, text: node.text, level: level)
      case .codeBlock(let language):
        block = MarkdownBlock(
          id: block.id, kind: .code,
          text: AttributedString(String(node.text.characters).trimmingCharacters(in: .newlines)),
          label: language ?? "Plain text")
      case .blockQuote: block = MarkdownBlock(id: block.id, kind: .quote, children: blocks(node))
      case .thematicBreak: block = MarkdownBlock(id: block.id, kind: .rule)
      case .listItem(let ordinal):
        var children = blocks(node)
        var label = parent.kind == .orderedList ? "\(ordinal)." : "•"
        if parent.kind == .unorderedList, let first = children.first, first.kind == .paragraph,
          let checkbox = node.children.first?.checkbox
        {
          label = checkbox.label
          let offset = min(checkbox.count, first.text.characters.count)
          children[0].text = AttributedString(
            first.text[first.text.characters.index(first.text.startIndex, offsetBy: offset)...])
        }
        block = MarkdownBlock(id: block.id, kind: .listItem, label: label, children: children)
      case .table(let columns):
        let rows = node.children.map { row in
          columns.indices.map { column in
            row.children.first { $0.kind == .tableCell(columnIndex: column) }?.text
              ?? AttributedString()
          }
        }
        block = MarkdownBlock(id: block.id, kind: .table, rows: rows)
      default: break
      }
      return [block]
    }
  }
}

struct MarkdownText: View {
  let document: MarkdownDocument
  // Measure the real blocks on the first frame; deferred parsing leaves a false bottom anchor.
  init(text: String) { document = MarkdownDocument(text) }
  var body: some View { MarkdownBlocks(blocks: document.blocks) }
}

private struct MarkdownBlocks: View {
  let blocks: [MarkdownBlock]
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      ForEach(blocks) { block in render(block) }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
  private func render(_ block: MarkdownBlock) -> AnyView {
    switch block.kind {
    case .paragraph:
      return AnyView(
        Text(block.text).font(.body).lineSpacing(4).textSelection(.enabled).fixedSize(
          horizontal: false, vertical: true))
    case .heading:
      return AnyView(
        Text(block.text).font(
          block.level == 1 ? .title2.bold() : block.level == 2 ? .title3.bold() : .headline
        )
        .padding(.top, 8).textSelection(.enabled).accessibilityAddTraits(.isHeader))
    case .code:
      return AnyView(CodeBlockView(code: String(block.text.characters), language: block.label))
    case .quote:
      return AnyView(
        HStack(alignment: .top, spacing: 12) {
          Rectangle().fill(.secondary.opacity(0.4)).frame(width: 3)
          MarkdownBlocks(blocks: block.children)
        }.fixedSize(horizontal: false, vertical: true))
    case .listItem:
      return AnyView(
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(block.label).monospacedDigit().frame(minWidth: 24, alignment: .trailing)
          MarkdownBlocks(blocks: block.children)
        })
    case .table: return AnyView(MarkdownTable(rows: block.rows))
    case .rule: return AnyView(Divider().padding(.vertical, 4))
    }
  }
}

struct CopyTextButton: View {
  let text: String
  var label = "Copy"
  @State private var copied = false
  var body: some View {
    Button(copied ? "Copied" : label, systemImage: copied ? "checkmark" : "doc.on.doc") {
      UIPasteboard.general.string = text
      copied = UIPasteboard.general.string == text
    }.font(.caption).frame(minWidth: 44, minHeight: 44).accessibilityLabel(
      copied ? "Copied" : label
    )
    .onChange(of: text) { _, _ in copied = false }
  }
}

struct CodeBlockView: View {
  let code: String
  let language: String
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(language.isEmpty ? "Plain text" : language).font(.caption).foregroundStyle(.secondary)
        Spacer()
        CopyTextButton(text: code, label: "Copy code")
      }
      .padding(.horizontal, 12)
      ScrollView(.horizontal) {
        Text(code).font(.system(.subheadline, design: .monospaced)).textSelection(.enabled)
          .fixedSize().padding(12)
      }.scrollIndicators(.visible)
    }.background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
  }
}

private struct MarkdownTable: View {
  @Environment(\.pauseTranscriptFollowing) private var pauseFollowing
  let rows: [[AttributedString]]
  @State private var showsRows = false
  @ScaledMetric(relativeTo: .body) private var columnWidth = 180
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Label(
          showsRows ? "Table rows" : "Swipe to see columns",
          systemImage: showsRows ? "list.bullet" : "arrow.left.and.right"
        )
        .font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button(showsRows ? "Columns" : "Read as rows") {
          pauseFollowing()
          showsRows.toggle()
        }.font(.caption).frame(minHeight: 44)
      }
      if showsRows {
        ForEach(Array(rows.dropFirst().enumerated()), id: \.offset) { _, row in
          VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
              VStack(alignment: .leading, spacing: 4) {
                if let head = rows.first, head.indices.contains(index) {
                  Text(head[index]).font(.subheadline.bold())
                }
                Text(cell).textSelection(.enabled)
              }
            }
          }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(
            Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        }
      } else {
        ScrollView(.horizontal) {
          Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
              GridRow {
                ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                  Text(cell).font(index == 0 ? .subheadline.bold() : .subheadline).textSelection(
                    .enabled
                  )
                  .frame(width: columnWidth, alignment: .topLeading).padding(12)
                  .background(index == 0 ? Color(.secondarySystemBackground) : Color.clear)
                }
              }
              Divider()
            }
          }
        }.scrollIndicators(.visible)
      }
    }
  }
}
