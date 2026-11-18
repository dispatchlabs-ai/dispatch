import SwiftUI

struct ToolActivityView: View {
  let tools: [DispatchTool]
  @Environment(\.pauseTranscriptFollowing) private var pauseFollowing
  @State private var expanded = false
  private var active: [DispatchTool] {
    tools.filter { ["pending", "running", "waiting"].contains($0.status) }
  }
  private var failures: Int { tools.filter { $0.status == "failed" }.count }
  var body: some View {
    DisclosureGroup(
      isExpanded: Binding(
        get: { expanded },
        set: {
          pauseFollowing()
          expanded = $0
        })
    ) {
      VStack(alignment: .leading, spacing: 12) {
        ForEach(tools) { ToolDetail(tool: $0) }
      }.padding(.top, 10)
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        Label(
          "\(tools.count) \(tools.count == 1 ? "tool" : "tools")"
            + (active.isEmpty ? "" : " · \(active.count) active"), systemImage: "terminal"
        )
        .font(.subheadline.weight(.medium))
        if let current = active.first {
          Text("\(current.name) · \(current.status == "running" ? "Running" : "Waiting")").font(
            .caption)
        } else if failures > 0 {
          Label(
            "\(failures) \(failures == 1 ? "error" : "errors")",
            systemImage: "exclamationmark.circle"
          ).font(.caption)
        } else {
          Text("Show commands and results").font(.caption)
        }
      }.foregroundStyle(.secondary).padding(.vertical, 6)
    }.tint(.secondary).accessibilityIdentifier("tool-activity")
  }
}

private struct ToolDetail: View {
  let tool: DispatchTool
  private var output: String { tool.output?.text ?? tool.progress?.text ?? "" }
  @Environment(\.pauseTranscriptFollowing) private var pauseFollowing
  @State private var expanded = false
  private var status: String {
    switch tool.status {
    case "running": return "Running"
    case "pending", "waiting": return "Waiting"
    case "failed": return "Failed"
    case "completed": return "Succeeded"
    case "unavailable": return "Outcome unavailable"
    default: return tool.status.capitalized
    }
  }
  var body: some View {
    DisclosureGroup(
      isExpanded: Binding(
        get: { expanded },
        set: {
          pauseFollowing()
          expanded = $0
        })
    ) {
      VStack(alignment: .leading, spacing: 8) {
        if let arguments = tool.input?.text, !arguments.isEmpty {
          Text("Arguments").font(.caption.weight(.semibold))
          ToolOutput(text: arguments)
        }
        if !output.isEmpty {
          Text("Output").font(.caption.weight(.semibold))
          ToolOutput(text: output)
        } else {
          Text("No text output recorded.").font(.caption).foregroundStyle(.secondary)
        }
        CopyTextButton(text: output, label: "Copy output").disabled(output.isEmpty)
      }.padding(.top, 8)
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(tool.name).font(.subheadline.weight(.medium))
        Spacer(minLength: 4)
        Label(
          status,
          systemImage: tool.status == "failed"
            ? "exclamationmark.circle"
            : tool.status == "completed" ? "checkmark.circle" : "circle.dotted"
        )
        .font(.caption).foregroundStyle(.secondary)
      }.frame(minHeight: 44)
    }.tint(.primary)
  }
}

private struct ToolOutput: View {
  let text: String
  @ScaledMetric(relativeTo: .caption) private var lineHeight = 18
  var body: some View {
    ScrollView([.vertical, .horizontal]) {
      Text(text).font(.system(.caption, design: .monospaced)).textSelection(.enabled).fixedSize()
        .padding(10)
    }.frame(
      height: min(240, max(64, CGFloat(text.components(separatedBy: "\n").count) * lineHeight + 20))
    )
    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
  }
}
