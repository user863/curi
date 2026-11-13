import { ReactNode } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from './ui';
import { fmtTime, reasonText } from '../../js/views.js';
import { emptyProfile, forgetInterest, withRoom } from '../../js/rank.js';
import * as Log from '../../js/log.js';
import type { FeedController } from './feed';
import { update } from './store';
import { tonePalette } from './theme';
import { deviceLang, tagLabel } from '../../js/vocab.js';

const LICENSE = { CC0: 'CC0', PDM: 'Public domain', 'NASA-PD': 'NASA public domain', 'CC-BY': 'CC BY', 'CC-BY-SA': 'CC BY-SA', 'LOC-FREE': 'Free to use', 'LOC-ATTR': 'Free to use, credit' } as Record<string, string>;
const label = (r: any) => LICENSE[r.license] || r.license;
const join = (parts: (string | undefined)[], sep = ' · ') => parts.filter(Boolean).join(sep);
const P = tonePalette('paper');

const Sheet = ({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) => (
  <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <View style={[styles.sheet, { backgroundColor: P.bg }]}>
      <Pressable onPress={onClose} style={styles.close}><Text style={styles.closeText}>Close</Text></Pressable>
      <ScrollView contentContainerStyle={styles.body}>{children}</ScrollView>
    </View>
  </Modal>
);

const Row = ({ k, v }: { k: string; v?: string }) => (v ? (
  <View style={styles.row}><Text style={styles.k}>{k}</Text><Text style={styles.v}>{v}</Text></View>
) : null);

const Chips = ({ items }: { items: string[] }) => (
  <View style={styles.chips}>{items.map((t) => <Text key={t} style={styles.chip}>{t}</Text>)}</View>
);

export const InfoSheet = ({ data, onClose }: { data: { card: any; detail: any; vocab?: any; reason: any; rooms: any; categories: any[] } | null; onClose: () => void }) => {
  if (!data) return <Sheet visible={false} onClose={onClose}>{null}</Sheet>;
  const { card, detail, vocab, reason, rooms, categories } = data;
  const lang = deviceLang();
  const rights = { ...card.rights, ...detail?.rights };
  const source = { ...card.source, ...detail?.source };
  const m = card.media || detail?.media ? { ...card.media, ...detail?.media } : undefined;
  const ed = card.editorial;
  const verb = { image: 'View at the source', video: 'Watch the full film', audio: 'Open the full recording', passage: 'Read the full text' }[card.type as string];
  return (
    <Sheet visible onClose={onClose}>
      <Text style={styles.h2}>{card.title}</Text>
      <Text style={styles.line}>{join([card.creator === 'Unknown' ? '' : card.creator, card.date], ', ')}</Text>
      {ed.note ? <><Text style={styles.dim}>{ed.noteSource === 'curator' ? '' : 'From the source description'}</Text><Text style={styles.note}>{ed.note}</Text></> : null}
      <Pressable onPress={() => Linking.openURL(source.url)}><Text style={styles.link}>{verb} ↗</Text></Pressable>
      <Text style={styles.dim}>Why you are seeing this</Text>
      <Text style={styles.note}>{reasonText(reason, rooms, categories)}</Text>
      {detail?.colour ? (
        <View style={{ marginTop: 10 }}>
          <View style={{ flexDirection: 'row', height: 22, borderRadius: 3, overflow: 'hidden' }}>
            {detail.colour.pal.map(([hex, share]: [string, number]) => <View key={hex} style={{ flex: share, backgroundColor: `#${hex}` }} />)}
          </View>
          {detail.colour.tone.length ? <Text style={styles.dim}>{detail.colour.tone.join(' · ')}</Text> : null}
        </View>
      ) : null}
      <Chips items={[rooms[ed.room] ?? ed.room, ...ed.tags.map((t: string) => tagLabel(vocab, t, lang))]} />
      <Text style={styles.dim}>Ranking runs on this device. Nothing about what you look at is sent unless you opt in to share usage data.</Text>
      <View style={{ marginTop: 8 }}>
        <Row k="Source" v={source.institution} />
        <Row k="Creator" v={card.creator} />
        <Row k="Date" v={card.date} />
        <Row k="Collection" v={source.collection} />
        {card.type === 'image' ? <Row k="Medium" v={m?.medium} /> : null}
        {card.type === 'image' ? <Row k="Culture" v={m?.culture} /> : null}
        {card.type === 'image' ? <Row k="Credit" v={rights.creditLine} /> : null}
        {card.type === 'video' || card.type === 'audio' ? <Row k="Excerpt" v={`${fmtTime(m.end - m.start)} of ${fmtTime(m.duration)}`} /> : null}
        <Row k="License" v={`${label(rights)} · ${rights.jurisdictions}`} />
        <Row k="Attribution" v={rights.attribution} />
        <Row k="Rights check" v={rights.verifiedBy === 'unknown' ? 'Not yet verified by a person' : rights.verifiedBy} />
        <Row k="Retrieved" v={source.fetchedAt} />
      </View>
    </Sheet>
  );
};

const Toggle = ({ on, text, onPress }: { on: boolean; text: string; onPress: () => void }) => (
  <Pressable onPress={onPress} style={[styles.toggle, on && { backgroundColor: '#000' }]}><Text style={[styles.toggleText, on && { color: '#fff' }]}>{text}</Text></Pressable>
);

export const SettingsSheet = ({ visible, onClose, feed, state, events }: { visible: boolean; onClose: () => void; feed: FeedController | null; state: any; events: any[] }) => {
  if (!visible || !feed) return <Sheet visible={false} onClose={onClose}>{null}</Sheet>;
  const cat = feed.catalog;
  const mix = feed.mix();
  const profile = state.profile;
  const follows = (r: string) => profile.cents.some((c: any) => c.room === r);
  const labelsOf = (c: any) => Object.entries(c.labels).sort((x: any, y: any) => y[1] - x[1]).slice(0, 3).map(([l]) => String(l).slice(2).replace(/-/g, ' ')).join(', ');
  const list = (kind: 'cents' | 'negs', title: string) => (profile[kind].some((c: any) => !c.soft) ? (
    <>
      <Text style={styles.dim}>{title}</Text>
      {profile[kind].map((c: any, i: number) => (c.soft ? null : (
        <View key={`${kind}${i}`} style={styles.forget}>
          <Text style={{ flex: 1 }}>{labelsOf(c)}</Text>
          <Pressable onPress={() => { update({ profile: forgetInterest(profile, kind, i) }); feed.reprofile(); }}><Text style={styles.link}>Forget</Text></Pressable>
        </View>
      )))}
    </>
  ) : null);
  return (
    <Sheet visible onClose={onClose}>
      <Text style={styles.h2}>Settings</Text>
      <Text style={styles.dim}>Your interests are stored on this device. Edit or clear them any time.</Text>
      <View style={styles.chips}>
        {Object.entries(cat.rooms).map(([r, text]) => (
          <Toggle key={r} on={follows(r)} text={String(text)} onPress={() => {
            update({ profile: withRoom(profile, r, !follows(r), cat.roomVec(r), cat.manifest.roomCategories[r]) });
            feed.reprofile();
          }} />
        ))}
      </View>
      <Text style={styles.dim}>Card colour</Text>
      <View style={styles.chips}>
        {[['palette', 'Palette'], ['image', 'Matched to the picture']].map(([id, text]) => (
          <Toggle key={id} on={state.colour === id} text={text} onPress={() => update({ colour: id })} />
        ))}
      </View>
      <Text style={styles.dim}>Your mix</Text>
      <Chips items={cat.categories.map((c: any) => `${c.label} ${Math.round(mix[c.id] * 100)}%`)} />
      {list('cents', 'More of')}
      {list('negs', 'Less of')}
      <Text style={styles.dim}>Activity on this device</Text>
      <Text style={styles.note}>{Log.summary(events) ? JSON.stringify(Log.summary(events)) : 'Nothing yet.'}</Text>
      <Pressable style={styles.btn} onPress={() => { update({ seen: new Uint8Array(0), profile: emptyProfile() }); feed.reprofile(); }}>
        <Text style={styles.btnText}>Reset interests</Text>
      </Pressable>
    </Sheet>
  );
};

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  close: { alignSelf: 'flex-end', padding: 16 },
  closeText: { fontSize: 15, fontWeight: '500' },
  body: { padding: 22, paddingTop: 0, gap: 10 },
  h2: { fontSize: 24, fontWeight: '500', letterSpacing: -0.5 },
  line: { fontSize: 15 },
  dim: { fontSize: 13, color: P.dim, marginTop: 8 },
  note: { fontSize: 15, lineHeight: 21 },
  link: { fontSize: 15, textDecorationLine: 'underline', marginVertical: 4 },
  row: { flexDirection: 'row', paddingVertical: 5, gap: 12 },
  k: { width: 96, fontSize: 13, color: P.dim },
  v: { flex: 1, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { fontSize: 13, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: '#0004', overflow: 'hidden' },
  toggle: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: '#0006' },
  toggleText: { fontSize: 13 },
  forget: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  btn: { alignSelf: 'flex-start', marginTop: 12, paddingVertical: 10, paddingHorizontal: 18, borderRadius: 999, backgroundColor: '#000' },
  btnText: { color: '#fff', fontWeight: '500' },
});

// Kokoro voice styles by prefix: af/am American female/male, bf/bm British.
const ACCENT: Record<string, string> = { af: 'American, female', am: 'American, male', bf: 'British, female', bm: 'British, male' };
const GROUPS = ['af', 'am', 'bf', 'bm'];

export const VoiceSheet = ({ visible, onClose, voices, chosen, onPick }: { visible: boolean; onClose: () => void; voices: string[]; chosen: string; onPick: (voice: string) => void }) => (
  <Sheet visible={visible} onClose={onClose}>
    <Text style={styles.h2}>Voice</Text>
    <Text style={styles.dim}>Read aloud runs Kokoro-82M on this device, the only model in the app. Pick a voice to hear it on the passage you are on.</Text>
    <View style={styles.chips}><Toggle on={chosen === 'random'} text="Random each time" onPress={() => onPick('random')} /></View>
    {GROUPS.map((g) => (
      <View key={g} style={{ gap: 8 }}>
        <Text style={styles.dim}>{ACCENT[g]}</Text>
        <View style={styles.chips}>
          {voices.filter((v) => v.startsWith(g)).map((v) => (
            <Toggle key={v} on={chosen === v} text={v.slice(3).replace(/^./, (c) => c.toUpperCase())} onPress={() => onPick(v)} />
          ))}
        </View>
      </View>
    ))}
  </Sheet>
);
