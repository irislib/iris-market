import SwiftUI

extension MarketPerson {
    var displayName: String {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty || value == "Unnamed user" ? NativeProfileNames.name(seed: author) : value
    }
    static func unnamed(_ author: String) -> MarketPerson {
        MarketPerson(author: author, name: NativeProfileNames.name(seed: author), pictureUrl: nil, connection: MarketConnection(badge: nil, followDistance: nil, followedByFriends: 0, description: ""))
    }
}

struct UserAvatar: View {
    let person: MarketPerson
    var size: CGFloat = 40
    private var identicon: some View {
        Canvas { context, bounds in
            let bytes = Array(person.author.utf8)
            let cell = bounds.width / 7
            for row in 0..<5 {
                for column in 0..<3 {
                    let value = bytes.isEmpty ? UInt8(row + column) : bytes[(row * 3 + column) % bytes.count]
                    if value & 1 == 1 {
                        for x in Set([column, 4 - column]) {
                            context.fill(Path(roundedRect: CGRect(x: CGFloat(x + 1) * cell, y: CGFloat(row + 1) * cell, width: cell, height: cell), cornerRadius: cell * 0.2), with: .color(MarketTheme.green))
                        }
                    }
                }
            }
        }
    }
    var body: some View {
        Group {
            if let raw = person.pictureUrl, let url = URL(string: raw) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() } else { identicon }
                }
            } else { identicon }
        }.frame(width: size, height: size).background(MarketTheme.mint).clipShape(Circle()).accessibilityHidden(true)
    }
}

struct UserName: View {
    let person: MarketPerson
    var body: some View {
        HStack(spacing: 5) { Text(person.displayName).lineLimit(1); ConnectionBadge(connection: person.connection) }
    }
}

struct UserRow: View {
    let person: MarketPerson
    var subtitle: String? = nil
    var size: CGFloat = 40
    var body: some View {
        HStack(spacing: 12) {
            UserAvatar(person: person, size: size)
            VStack(alignment: .leading, spacing: 4) {
                UserName(person: person).font(.subheadline.weight(.medium))
                if let subtitle, !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(MarketTheme.muted).lineLimit(2) }
            }
            Spacer(minLength: 0)
        }.foregroundStyle(MarketTheme.ink)
    }
}
