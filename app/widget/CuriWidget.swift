// Home-screen widget: one high-quality picture a day on a background matched to it. A tap opens the picture in the app.
// The list comes from the hosted pack (data/pack/daily.json, written by pipeline/daily.py); the day picks the entry, so
// every device shows the same picture on the same day. The background colour is computed in the pipeline with the app's matcher.
import ImageIO
import SwiftUI
import WidgetKit

private let dailyURL = URL(string: "https://user863.github.io/curi/data/pack/daily.json")!
private let scheme = "com.johannbraun.commonplace"

struct Pick: Decodable {
    let id: Int
    let title: String
    let creator: String
    let image: String
    let bg: String
    let fg: String
}

private struct Daily: Decodable { let picks: [Pick] }

struct PictureEntry: TimelineEntry {
    let date: Date
    let pick: Pick?
    let image: UIImage?
}

extension Color {
    init(hex: String) {
        var v: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&v)
        self.init(red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255, blue: Double(v & 255) / 255)
    }
}

// Decodes at a widget's size rather than the picture's: a widget has a small memory budget.
private func downsample(_ data: Data, maxPixel: CGFloat) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPixel, kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
}

private func load(for date: Date) async -> PictureEntry {
    do {
        let (data, _) = try await URLSession.shared.data(from: dailyURL)
        let picks = try JSONDecoder().decode(Daily.self, from: data).picks
        guard !picks.isEmpty else { return PictureEntry(date: date, pick: nil, image: nil) }
        let day = Calendar.current.ordinality(of: .day, in: .era, for: date) ?? 0
        let pick = picks[day % picks.count]
        var image: UIImage?
        if let url = URL(string: pick.image), let (bytes, _) = try? await URLSession.shared.data(from: url) {
            image = downsample(bytes, maxPixel: 900)
        }
        return PictureEntry(date: date, pick: pick, image: image)
    } catch {
        return PictureEntry(date: date, pick: nil, image: nil)
    }
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> PictureEntry { PictureEntry(date: Date(), pick: nil, image: nil) }

    func getSnapshot(in context: Context, completion: @escaping (PictureEntry) -> Void) {
        Task { completion(await load(for: Date())) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<PictureEntry>) -> Void) {
        Task {
            let now = Date()
            let entry = await load(for: now)
            let midnight = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now)) ?? now.addingTimeInterval(86400)
            completion(Timeline(entries: [entry], policy: .after(entry.pick == nil ? now.addingTimeInterval(1800) : midnight)))
        }
    }
}

struct PictureView: View {
    let entry: PictureEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let background = Color(hex: entry.pick?.bg ?? "#d9d2c5")
        let ink = Color(hex: entry.pick?.fg ?? "#000000")
        let small = family == .systemSmall
        VStack(spacing: 8) {
            if let image = entry.image {
                Image(uiImage: image)
                    .resizable().aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .shadow(color: .black.opacity(0.2), radius: 5, y: 2)
            } else {
                Text("Curi").font(.title3.weight(.medium)).foregroundStyle(ink).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if !small, let pick = entry.pick {
                VStack(alignment: .leading, spacing: 1) {
                    Text(pick.title).font(.footnote.weight(.medium)).lineLimit(1)
                    Text(pick.creator).font(.caption2).opacity(0.7).lineLimit(1)
                }
                .foregroundStyle(ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(small ? 12 : 16)
        .containerBackground(background, for: .widget)
        .widgetURL(URL(string: entry.pick.map { "\(scheme)://work/\($0.id)" } ?? "\(scheme)://"))
    }
}

@main
struct PictureOfTheDay: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "PictureOfTheDay", provider: Provider()) { entry in
            PictureView(entry: entry)
        }
        .configurationDisplayName("Picture of the day")
        .description("A high-quality picture on a matching background. Tap to open it in Curi.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
