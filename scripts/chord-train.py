# Trains the learned chord recognizer on features dumped by
# scripts/chord-data.ts (tune split only) and writes its weights to
# ts/chord-model.ts. Needs Python with numpy and PyTorch (CPU is enough:
# ~25 minutes on 16 threads).
#
#   python scripts/chord-train.py --data <dir> --synth --labels perf          # the shipped model, whole tune split
#   python scripts/chord-train.py --data <dir> --synth --labels perf --val    # hold out GuitarSet player 01 + half
#       of IDMT, report bench-level scores raw and with each --stay / --power / --none-bias HMM setting
#
# Model (mirrored exactly by ts/chords.ts):
#  1. Harmonic stacking (Bittner et al., "A Lightweight Instrument-Agnostic
#     Model for Polyphonic Note Transcription", ICASSP 2022): the 3-bin-per-
#     semitone log spectrum is copied at the offsets of sub-harmonics 1/5-1/2
#     and harmonics 1-7, so small kernels see a note's whole overtone series
#     and the notes it could be an overtone of.
#  2. Three small convolutions along pitch (shared at every pitch, so the
#     note model is transposition-equivariant and needs no pitch-shift
#     augmentation) -> one salience per semitone, C2..B6, trained against
#     GuitarSet's per-string note annotations: a learned stand-in for Mauch &
#     Dixon's NNLS approximate transcription (ISMIR 2010) and Korzeniowski &
#     Widmer's deep chroma (ISMIR 2016).
#  3. Chroma (noisy-OR of the saliences over octaves) and a bass chroma (the
#     probability that each note is the lowest one sounding), plus per-pitch-
#     class pooled hidden features, rotated to each candidate root and fed to
#     one small MLP shared by all twelve roots -> scores for the 8 chord types;
#     a separate logit for "no chord". Softmax over 12 x 8 + 1 classes.
import argparse
import json
import math
import os

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

CONDITIONS = ['clean', 'phone-good', 'phone-mid', 'phone-cheap', 'unplugged']
TYPES = ['', 'm', '7', 'm7', 'maj7', '9', 'sus2', 'sus4']
TYPE_QUALITY = ['maj', 'min', '7', 'min7', 'maj7', '9', 'sus2', 'sus4']
N_CLASS = 96
UNKNOWN = 255
LOG_LOW_MIDI = 24
BPS = 3
LOW_NOTE = 36
NOTES = 60
FINE = NOTES * BPS
# Sub-harmonics 1/5..1/2 let the note model see whether a peak is the 3rd,
# 4th or 5th harmonic of a lower note (an overtone, not a played note), the
# question NNLS chroma answers by its dictionary; Basic Pitch needs only 1/2
# because its kernels span three octaves.
HARMONICS = [1 / 5, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 5, 6, 7]
OFFSETS = [round(BPS * 12 * math.log2(h)) for h in HARMONICS]
FIRST = (LOW_NOTE - LOG_LOW_MIDI) * BPS

# Bench reductions (scripts/bench.ts MAJMIN / SEVENTHS).
MAJMIN = {'maj': 'maj', '7': 'maj', 'maj7': 'maj', '9': 'maj', 'maj6': 'maj', 'min': 'min', 'min7': 'min', 'min6': 'min'}
SEVENTHS = {'maj': 'maj', 'maj6': 'maj', 'min': 'min', 'min6': 'min', '7': '7', '9': '7', 'maj7': 'maj7', 'min7': 'min7'}


def load(data, conditions, synth=False):
	parts = []
	ids = []
	# Bench reference qualities are read on the recordings only (validation never sees synthetic takes).
	qualities = json.load(open(os.path.join(data, conditions[0] + '.meta.json')))['qualities']
	for prefix in [''] + (['synth-'] if synth else []):
		meta = json.load(open(os.path.join(data, prefix + conditions[0] + '.meta.json')))
		offset = len(ids)
		ids += meta['items']
		for c in conditions:
			parts.append(load_part(os.path.join(data, prefix + c), c, offset))
	out = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
	return out, {'items': ids, 'qualities': qualities}


def load_part(base, c, offset):
	meta = json.load(open(base + '.meta.json'))
	n = meta['frames']
	return dict(
		feat=np.fromfile(base + '.feat', np.uint8).reshape(n, meta['bins']),
		notes=np.fromfile(base + '.notes', np.uint8).reshape(n, NOTES),
		instr=np.fromfile(base + '.instr', np.uint8),
		perf=np.fromfile(base + '.perf', np.uint8),
		ref=np.fromfile(base + '.ref', np.int16).reshape(n, 2),
		seg=np.fromfile(base + '.seg', np.int32),
		item=np.fromfile(base + '.item', np.int16).astype(np.int32) + offset,
		cond=np.full(n, CONDITIONS.index(c), np.int8),
	)


class ChordNet(nn.Module):
	def __init__(self, c1=16, c2=16, c3=16, hidden=32, pooled=True):
		super().__init__()
		self.pooled = pooled
		self.conv1 = nn.Conv1d(len(HARMONICS), c1, 5, padding=2)
		self.conv2 = nn.Conv1d(c1, c2, 3, stride=3, padding=1)
		self.conv3 = nn.Conv1d(c2, c3, 5, padding=2)
		self.salience = nn.Conv1d(c3, 1, 1)
		self.note_bias = nn.Parameter(torch.zeros(NOTES))
		head_in = 24 + (c3 if pooled else 0) * 12
		self.head1 = nn.Linear(head_in, hidden)
		self.head2 = nn.Linear(hidden, len(TYPES))
		self.none1 = nn.Linear(26, 16)
		self.none2 = nn.Linear(16, 1)
		index = torch.full((len(HARMONICS), FINE), 10_000, dtype=torch.long)
		for h, off in enumerate(OFFSETS):
			for t in range(FINE):
				j = FIRST + t + off
				if 0 <= j < 316:
					index[h, t] = j
		self.register_buffer('index', index.clamp(max=316))
		# Rotation indices: rot[r, i] = (r + i) % 12.
		self.register_buffer('rot', (torch.arange(12)[:, None] + torch.arange(12)[None, :]) % 12)

	def forward(self, v):
		b = v.shape[0]
		padded = torch.cat([v, v.new_zeros(b, 1)], 1)
		x = padded[:, self.index]  # b, len(HARMONICS), FINE
		x = F.relu(self.conv1(x))
		x = F.relu(self.conv2(x))
		z = F.relu(self.conv3(x))  # b, c3, NOTES
		note_logits = self.salience(z)[:, 0] + self.note_bias
		p = torch.sigmoid(note_logits)
		octaves = p.view(b, NOTES // 12, 12)
		chroma = 1 - torch.prod(1 - octaves, 1)
		below = torch.cumprod(torch.cat([p.new_ones(b, 1), 1 - p[:, :-1]], 1), 1)
		bass = (p * below).view(b, NOTES // 12, 12).sum(1)
		feats = [chroma[:, self.rot], bass[:, self.rot]]  # b, 12 roots, 12
		if self.pooled:
			pooled = z.view(b, z.shape[1], NOTES // 12, 12).amax(2)  # b, c3, 12
			feats.append(pooled[:, :, self.rot].permute(0, 2, 1, 3).reshape(b, 12, -1))
		h = F.relu(self.head1(torch.cat(feats, 2)))
		chord = self.head2(h).reshape(b, 12 * len(TYPES))
		stats = torch.cat([chroma.sort(1, descending=True).values, bass.sort(1, descending=True).values, p.sum(1, keepdim=True), p.amax(1, keepdim=True)], 1)
		none = self.none2(F.relu(self.none1(stats)))
		return torch.cat([chord, none], 1), note_logits


def bench_scores(pred, ref, qualities):
	"""Frame recall at the bench's root / majmin / sevenths levels (refs outside a level skipped)."""
	out = {}
	root = ref[:, 0]
	q = [qualities[i] if 0 <= i < len(qualities) else None for i in ref[:, 1]]
	proot = np.where(pred < N_CLASS, pred // 8, -1)
	pq = [TYPE_QUALITY[c % 8] if c < N_CLASS else None for c in pred]
	valid = root >= 0
	out['root'] = (proot[valid] == root[valid]).mean()
	for name, table in [('majmin', MAJMIN), ('sevenths', SEVENTHS)]:
		hits = frames = 0
		for i in np.nonzero(valid)[0]:
			if q[i] not in table:
				continue
			frames += 1
			hits += proot[i] == root[i] and pq[i] is not None and table.get(pq[i]) == table[q[i]]
		out[name] = hits / max(frames, 1)
	return out


def latency(pred, ref, seg, qualities):
	"""Median frames from a segment's first frame until it is named right (majmin), × 100 ms."""
	first = {}
	seen = {}
	for i, s in enumerate(seg):
		if s < 0:
			continue
		seen.setdefault(s, i)
		r, qi = ref[i]
		if s in first or r < 0 or pred[i] >= N_CLASS:
			continue
		q = qualities[qi] if qi < len(qualities) else None
		if pred[i] // 8 == r and q in MAJMIN and MAJMIN.get(TYPE_QUALITY[pred[i] % 8]) == MAJMIN[q]:
			first[s] = i - seen[s]
	return 186 + 50 + 100 * np.median(list(first.values())) if first else float('nan')


def smooth(logp, items, stay, power, none_bias=0.0):
	"""HMM forward filtering (online, no lag) with a uniform switch probability, per item."""
	logp = logp.copy()
	logp[:, N_CLASS] -= none_bias
	out = np.empty(len(logp), np.int64)
	k = logp.shape[1]
	alpha = None
	last = None
	for i in range(len(logp)):
		if items[i] != last:
			alpha = np.full(k, 1 / k)
			last = items[i]
		obs = np.exp(power * (logp[i] - logp[i].max()))
		alpha = obs * (stay * alpha + (1 - stay) / k)
		alpha /= alpha.sum()
		out[i] = alpha.argmax()
	return out


def predict(model, feat, batch=4096):
	model.eval()
	outs = []
	with torch.no_grad():
		for i in range(0, len(feat), batch):
			v = torch.from_numpy(feat[i:i + batch].astype(np.float32) / 255)
			logits, _ = model(v)
			outs.append(F.log_softmax(logits, 1).numpy())
	return np.concatenate(outs)


def train(model, d, mask, labels, epochs, lr, note_weight, seed=0):
	torch.manual_seed(seed)
	rng = np.random.default_rng(seed)
	idx = np.nonzero(mask)[0]
	opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=1e-5)
	steps = epochs * math.ceil(len(idx) / 512)
	sched = torch.optim.lr_scheduler.OneCycleLR(opt, lr, total_steps=steps)
	for epoch in range(epochs):
		model.train()
		rng.shuffle(idx)
		total = 0
		for i in range(0, len(idx), 512):
			b = idx[i:i + 512]
			v = torch.from_numpy(d['feat'][b].astype(np.float32) / 255)
			y = torch.from_numpy(labels[b].astype(np.int64))
			nt = torch.from_numpy(d['notes'][b].astype(np.float32))
			logits, note_logits = model(v)
			loss = F.cross_entropy(logits, y, ignore_index=UNKNOWN) if (y != UNKNOWN).any() else logits.sum() * 0
			known = nt != UNKNOWN
			if known.any():
				loss = loss + note_weight * F.binary_cross_entropy_with_logits(note_logits[known], nt[known])
			opt.zero_grad()
			loss.backward()
			opt.step()
			sched.step()
			total += loss.item() * len(b)
		print(f'epoch {epoch + 1}: loss {total / len(idx):.4f}', flush=True)


def export(model, path, args, synth_takes):
	sd = {k.replace('.', '_'): v.detach().numpy() for k, v in model.state_dict().items() if k not in ('index', 'rot')}
	fmt = lambda a: '[' + ','.join(f'{x:.5g}' for x in a.ravel()) + ']'
	n = sum(v.size for v in sd.values())
	settings = {k: v for k, v in vars(args).items() if k in ('labels', 'synth', 'epochs', 'lr', 'note_weight', 'hidden', 'channels', 'no_pooled', 'conditions', 'threads')}
	# The synthetic take count (chord-data.ts --synth N); the thread count changes float summation order, so results only reproduce with it.
	settings['synth_takes'] = synth_takes
	lines = [
		'// Generated by scripts/chord-train.py - do not edit. Weights of the learned',
		'// chord recognizer (see ts/chords.ts), trained on the benchmark\'s tune split',
		'// only (GuitarSet players 00-01, IDMT-SMT-Guitar dataset4 "fast" takes) plus',
		f'// synthetic strums (scripts/chord-data.ts --synth), {n} parameters.',
		f'// Settings: {json.dumps(settings)}',
		'',
		'export const SHAPE = ' + json.dumps({k: list(v.shape) for k, v in sd.items()}),
		'',
	]
	for k, v in sd.items():
		lines.append(f'export const {k} = new Float32Array({fmt(v)})')
	open(path, 'w', encoding='utf8', newline='\n').write('\n'.join(lines) + '\n')
	torch.save(model.state_dict(), os.path.join(args.data, 'model.pt'))
	print(f'wrote {path}: {n} parameters')


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument('--data', required=True)
	ap.add_argument('--val', action='store_true')
	ap.add_argument('--labels', default='instr', choices=['instr', 'perf'])
	ap.add_argument('--epochs', type=int, default=12)
	ap.add_argument('--lr', type=float, default=3e-3)
	ap.add_argument('--note-weight', type=float, default=1.0)
	ap.add_argument('--hidden', type=int, default=32)
	ap.add_argument('--channels', type=int, default=16)
	ap.add_argument('--no-pooled', action='store_true')
	ap.add_argument('--conditions', default=','.join(CONDITIONS))
	ap.add_argument('--out', default='ts/music/chord-model.ts')
	ap.add_argument('--threads', type=int, default=8)
	ap.add_argument('--tag', default='model')
	ap.add_argument('--load', action='store_true', help='reuse the saved --val model (HMM grid only)')
	ap.add_argument('--stay', type=float, nargs='*', default=[0.9])
	ap.add_argument('--power', type=float, nargs='*', default=[1.0])
	ap.add_argument('--none-bias', type=float, nargs='*', default=[0.0])
	ap.add_argument('--verbose', action='store_true')
	ap.add_argument('--export', action='store_true', help='with --val: export the held-out model to --out too')
	ap.add_argument('--synth', action='store_true', help='also train on the synthetic takes (synth-* files)')
	args = ap.parse_args()
	torch.set_num_threads(args.threads)

	d, meta = load(args.data, args.conditions.split(','), args.synth)
	ids = meta['items']
	qualities = meta['qualities']
	item_ids = np.array(ids)[d['item']]
	labels = d[args.labels]
	if args.val:
		# Hold out GuitarSet player 01 and every other IDMT progression.
		idmt_index = {x: i for i, x in enumerate(sorted(x for x in ids if x.startswith('idmt')))}
		held = np.array([x.startswith('guitarset/01_') or (x in idmt_index and idmt_index[x] % 2 == 1) for x in item_ids])
	else:
		held = np.zeros(len(labels), bool)

	model = ChordNet(c1=args.channels, c2=args.channels, c3=args.channels, hidden=args.hidden, pooled=not args.no_pooled)
	saved = os.path.join(args.data, f'val-{args.tag}.pt')
	if args.load:
		model.load_state_dict(torch.load(saved))
	else:
		train(model, d, ~held, labels, args.epochs, args.lr, args.note_weight)

	if args.val:
		if not args.load:
			torch.save(model.state_dict(), saved)
		# Held-out frames per source and condition, scored raw and with each HMM setting.
		sets = []
		for name in ['guitarset', 'idmt']:
			for c, cname in enumerate(CONDITIONS):
				s = np.char.startswith(item_ids, name) & held & (d['cond'] == c) & (d['seg'] >= 0)
				if s.any():
					sets.append((name, cname, s, predict(model, d['feat'][s])))
		# Single-note lines (held-out GuitarSet solo frames with < 3 pitch classes) must stay "no chord".
		for c, cname in enumerate(CONDITIONS):
			s = held & (d['cond'] == c) & (d['seg'] < 0) & (d['instr'] == N_CLASS)
			if s.any():
				sets.append(('solo', cname, s, predict(model, d['feat'][s])))
		settings = [('raw', None, None, 0)] + [(f'stay {stay} pow {power} nb {nb}', stay, power, nb) for stay in args.stay for power in args.power for nb in args.none_bias]
		for label, stay, power, nb in settings:
			rows = {}
			for name, cname, s, logp in sets:
				pred = logp.argmax(1) if stay is None else smooth(logp, d['item'][s], stay, power, nb)
				if name == 'solo':
					rows.setdefault(f'solo/{"unplugged" if cname == "unplugged" else "phones"} none', []).append({'none': (pred == N_CLASS).mean()})
					continue
				r = bench_scores(pred, d['ref'][s], qualities)
				r['lat'] = latency(pred, d['ref'][s], d['seg'][s], qualities)
				group = f'{name}/{"unplugged" if cname == "unplugged" else "phones"}'
				rows.setdefault(group, []).append(r)
				if args.verbose:
					print(f'  {name:9} {cname:11} root {r["root"]:.3f} majmin {r["majmin"]:.3f} 7ths {r["sevenths"]:.3f} lat {r["lat"]:.0f}')
			line = ' | '.join(f'{g} {np.mean([r["none"] for r in rs]):.3f}' if 'none' in rs[0] else f'{g} {np.mean([r["root"] for r in rs]):.3f} {np.mean([r["majmin"] for r in rs]):.3f} {np.mean([r["sevenths"] for r in rs]):.3f} {np.mean([r["lat"] for r in rs]):.0f}ms' for g, rs in rows.items())
			print(f'{label:26} {line}', flush=True)
	if not args.val or args.export:
		export(model, args.out, args, sum(x.startswith('synth/') for x in ids))


if __name__ == '__main__':
	main()
