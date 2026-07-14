# Character stock icons

Filenames match Smash Ultimate's internal one-word fighter codenames (as
datamined from the game itself) rather than the English display names -
e.g. Bowser is `koopa.png`, Jigglypuff is `purin.png`, Villager is
`murabito.png`. The mapping lives in `CHARACTER_ICON_FILES` in
`src/lib/characters.js`. The character picker falls back to a plain letter
avatar if a file is missing, so the app works fine without these too.

Recommended: square images, transparent background, ~128x128px.

```
mario.png            Mario
donkey.png           Donkey Kong
link.png             Link
samus.png            Samus
samusd.png           Dark Samus
yoshi.png            Yoshi
kirby.png            Kirby
fox.png              Fox
pikachu.png          Pikachu
luigi.png            Luigi
ness.png             Ness
captain.png          Captain Falcon
purin.png            Jigglypuff
peach.png            Peach
daisy.png            Daisy
koopa.png            Bowser
ice_climber.png      Ice Climbers
sheik.png            Sheik
zelda.png            Zelda
mariod.png           Dr. Mario
pichu.png            Pichu
falco.png            Falco
marth.png            Marth
lucina.png           Lucina
younglink.png        Young Link
ganon.png            Ganondorf
mewtwo.png           Mewtwo
roy.png              Roy
chrom.png            Chrom
gamewatch.png        Mr. Game & Watch
metaknight.png       Meta Knight
pit.png              Pit
pitb.png             Dark Pit
szerosuit.png        Zero Suit Samus
wario.png            Wario
snake.png            Snake
ike.png              Ike
ptrainer.png         Pokémon Trainer
diddy.png            Diddy Kong
lucas.png            Lucas
sonic.png            Sonic
dedede.png           King Dedede
pikmin.png           Olimar
lucario.png          Lucario
robot.png            R.O.B.
toonlink.png         Toon Link
wolf.png             Wolf
murabito.png         Villager
rockman.png          Mega Man
wiifit.png           Wii Fit Trainer
rosetta.png          Rosalina & Luma
littlemac.png        Little Mac
gekkouga.png         Greninja
miifighter.png       Mii Brawler
miiswordsman.png     Mii Swordfighter
miigunner.png        Mii Gunner
palutena.png         Palutena
pacman.png           Pac-Man
reflet.png           Robin
shulk.png            Shulk
koopajr.png          Bowser Jr.
duckhunt.png         Duck Hunt
ryu.png              Ryu
ken.png              Ken
cloud.png            Cloud
kamui.png            Corrin
bayonetta.png        Bayonetta
inkling.png          Inkling
ridley.png           Ridley
simon.png            Simon
richter.png          Richter
krool.png            King K. Rool
shizue.png           Isabelle
gaogaen.png          Incineroar
packun.png           Piranha Plant
jack.png             Joker
brave.png            Hero
buddy.png            Banjo & Kazooie
dolly.png            Terry
master.png           Byleth
tantan.png           Min Min
pickel.png           Steve
edge.png             Sephiroth
eflame.png           Pyra/Mythra
demon.png            Kazuya
trail.png            Sora
```

A few files in this folder aren't used by any single roster entry -
`pzenigame`/`pfushigisou`/`plizardon` are Pokémon Trainer's individual
Pokémon (Squirtle/Ivysaur/Charizard), and `elight` is Mythra's alternate
form. The roster only has one slot each for "Pokémon Trainer" and
"Pyra/Mythra", mapped to `ptrainer` and `eflame` respectively.
