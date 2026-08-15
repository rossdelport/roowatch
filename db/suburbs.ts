/**
 * Australian suburbs for the onboarding wizard, grouped by the state a member
 * picked at signup. This is the metro and major regional set, not every one of
 * the 15,000 gazetted localities. A member can always type a suburb that is not
 * here, so a small town never blocks setup.
 */

export const SUBURBS: Record<string, string[]> = {
  "New South Wales": [
    "Sydney CBD", "Surry Hills", "Redfern", "Alexandria", "Newtown", "Marrickville",
    "Glebe", "Leichhardt", "Balmain", "Bondi", "Bondi Junction", "Coogee", "Randwick",
    "Maroubra", "Mascot", "Rosebery", "Zetland", "Waterloo", "Paddington", "Woollahra",
    "Double Bay", "Vaucluse", "Manly", "Dee Why", "Brookvale", "Freshwater", "Narrabeen",
    "Mona Vale", "Avalon", "Chatswood", "North Sydney", "Crows Nest", "Neutral Bay",
    "Mosman", "Lane Cove", "Artarmon", "Willoughby", "Ryde", "Macquarie Park", "Epping",
    "Eastwood", "Gordon", "Pymble", "St Ives", "Turramurra", "Wahroonga", "Hornsby",
    "Castle Hill", "Baulkham Hills", "Kellyville", "Rouse Hill", "Dural", "Parramatta",
    "Westmead", "Merrylands", "Auburn", "Lidcombe", "Strathfield", "Burwood", "Ashfield",
    "Blacktown", "Seven Hills", "Quakers Hill", "Penrith", "St Marys", "Windsor",
    "Richmond", "Liverpool", "Fairfield", "Cabramatta", "Bankstown", "Revesby",
    "Campbelltown", "Camden", "Narellan", "Cronulla", "Miranda", "Sutherland", "Caringbah",
    "Hurstville", "Kogarah", "Rockdale", "Brighton-Le-Sands", "Katoomba", "Springwood",
    "Wollongong", "Shellharbour", "Kiama", "Nowra", "Newcastle", "Charlestown", "Maitland",
    "Cessnock", "Nelson Bay", "Port Macquarie", "Coffs Harbour", "Byron Bay", "Ballina",
    "Lismore", "Tweed Heads", "Forster", "Taree", "Tamworth", "Armidale", "Dubbo",
    "Orange", "Bathurst", "Wagga Wagga", "Albury", "Griffith", "Goulburn", "Queanbeyan",
    "Batemans Bay", "Ulladulla",
  ],
  Victoria: [
    "Melbourne CBD", "Southbank", "Docklands", "Carlton", "Fitzroy", "Collingwood",
    "Richmond", "Abbotsford", "South Yarra", "Prahran", "Windsor", "Toorak", "Armadale",
    "Malvern", "St Kilda", "Elwood", "Brighton", "Sandringham", "Hampton", "Cheltenham",
    "Mentone", "Mordialloc", "Brunswick", "Coburg", "Pascoe Vale", "Glenroy", "Preston",
    "Reservoir", "Thornbury", "Northcote", "Ivanhoe", "Heidelberg", "Bundoora",
    "Greensborough", "Eltham", "Diamond Creek", "Doncaster", "Templestowe", "Box Hill",
    "Blackburn", "Ringwood", "Croydon", "Lilydale", "Bayswater", "Boronia",
    "Ferntree Gully", "Glen Waverley", "Mount Waverley", "Clayton", "Oakleigh",
    "Bentleigh", "Carnegie", "Caulfield", "Dandenong", "Noble Park", "Springvale",
    "Berwick", "Narre Warren", "Pakenham", "Cranbourne", "Officer", "Frankston",
    "Mornington", "Mount Eliza", "Rosebud", "Werribee", "Point Cook", "Hoppers Crossing",
    "Altona", "Williamstown", "Footscray", "Yarraville", "Sunshine", "St Albans",
    "Keilor", "Essendon", "Moonee Ponds", "Ascot Vale", "Broadmeadows", "Craigieburn",
    "Roxburgh Park", "Epping", "South Morang", "Mill Park", "Sunbury", "Melton",
    "Bacchus Marsh", "Geelong", "Ocean Grove", "Torquay", "Ballarat", "Bendigo",
    "Shepparton", "Wodonga", "Traralgon", "Warragul", "Warrnambool", "Mildura",
  ],
  Queensland: [
    "Brisbane CBD", "Fortitude Valley", "New Farm", "Newstead", "Teneriffe", "Bulimba",
    "Hawthorne", "Morningside", "Cannon Hill", "Carindale", "Camp Hill", "Coorparoo",
    "Greenslopes", "Mount Gravatt", "Sunnybank", "Calamvale", "Springfield", "Ipswich",
    "Forest Lake", "Inala", "Indooroopilly", "Toowong", "St Lucia", "Kenmore",
    "Chapel Hill", "The Gap", "Ashgrove", "Paddington", "Milton", "Clayfield", "Ascot",
    "Hamilton", "Nundah", "Chermside", "Aspley", "Albany Creek", "Everton Park",
    "Mitchelton", "Ferny Grove", "Strathpine", "North Lakes", "Redcliffe", "Caboolture",
    "Morayfield", "Narangba", "Burpengary", "Springwood", "Beenleigh", "Loganholme",
    "Shailer Park", "Browns Plains", "Southport", "Surfers Paradise", "Broadbeach",
    "Burleigh Heads", "Palm Beach", "Coolangatta", "Robina", "Nerang", "Helensvale",
    "Coomera", "Ormeau", "Maroochydore", "Mooloolaba", "Caloundra", "Noosa Heads",
    "Coolum Beach", "Buderim", "Nambour", "Gympie", "Hervey Bay", "Bundaberg",
    "Rockhampton", "Gladstone", "Mackay", "Townsville", "Cairns", "Toowoomba",
  ],
  "Western Australia": [
    "Perth CBD", "Northbridge", "East Perth", "West Perth", "Subiaco", "Leederville",
    "Mount Hawthorn", "Mount Lawley", "Maylands", "Bayswater", "Morley", "Dianella",
    "Balcatta", "Osborne Park", "Innaloo", "Karrinyup", "Scarborough", "Trigg",
    "Hillarys", "Sorrento", "Duncraig", "Greenwood", "Joondalup", "Currambine",
    "Clarkson", "Butler", "Yanchep", "Wanneroo", "Landsdale", "Ballajura", "Ellenbrook",
    "Midland", "Guildford", "Bassendean", "Belmont", "Cloverdale", "Victoria Park",
    "South Perth", "Como", "Applecross", "Booragoon", "Melville", "Bicton", "Fremantle",
    "North Fremantle", "Cottesloe", "Claremont", "Nedlands", "Shenton Park", "Bull Creek",
    "Willetton", "Canning Vale", "Thornlie", "Gosnells", "Armadale", "Byford",
    "Kelmscott", "Cannington", "Bentley", "Rockingham", "Baldivis", "Secret Harbour",
    "Mandurah", "Halls Head", "Pinjarra", "Bunbury", "Busselton", "Margaret River",
    "Albany", "Geraldton", "Kalgoorlie", "Broome", "Port Hedland", "Karratha",
  ],
  "South Australia": [
    "Adelaide CBD", "North Adelaide", "Prospect", "Walkerville", "Norwood", "Kensington",
    "Burnside", "Glenside", "Unley", "Mitcham", "Blackwood", "Glenelg", "Brighton",
    "Marion", "Morphett Vale", "Noarlunga", "Aldinga Beach", "Seaford", "Port Adelaide",
    "Semaphore", "Henley Beach", "Grange", "Findon", "Woodville", "Athelstone",
    "Modbury", "Golden Grove", "Tea Tree Gully", "Salisbury", "Elizabeth", "Munno Para",
    "Gawler", "Mount Barker", "Victor Harbor", "Murray Bridge", "Whyalla", "Port Lincoln",
    "Port Pirie", "Mount Gambier",
  ],
  Tasmania: [
    "Hobart", "Sandy Bay", "Battery Point", "North Hobart", "New Town", "Moonah",
    "Glenorchy", "Claremont", "Kingston", "Blackmans Bay", "Howrah", "Bellerive",
    "Rosny Park", "Lindisfarne", "Sorell", "Brighton", "Launceston", "Kings Meadows",
    "Newnham", "Riverside", "Legana", "Devonport", "Burnie", "Ulverstone", "Somerset",
    "Wynyard", "New Norfolk",
  ],
  "Australian Capital Territory": [
    "Canberra City", "Braddon", "Turner", "Dickson", "Lyneham", "Belconnen", "Bruce",
    "Kaleen", "Evatt", "Florey", "Holt", "Gungahlin", "Amaroo", "Ngunnawal", "Harrison",
    "Franklin", "Woden", "Phillip", "Curtin", "Weston", "Wanniassa", "Kambah",
    "Tuggeranong", "Greenway", "Calwell", "Gordon", "Conder", "Queanbeyan",
    "Jerrabomberra", "Fyshwick", "Deakin", "Yarralumla", "Kingston", "Narrabundah",
  ],
  "Northern Territory": [
    "Darwin", "Nightcliff", "Rapid Creek", "Fannie Bay", "Parap", "Stuart Park",
    "Larrakeyah", "Casuarina", "Karama", "Malak", "Leanyer", "Wanguri", "Palmerston",
    "Durack", "Farrar", "Rosebery", "Bakewell", "Gray", "Moulden", "Humpty Doo",
    "Howard Springs", "Katherine", "Alice Springs", "Tennant Creek", "Nhulunbuy",
  ],
};

/** Suburbs for a state, or every suburb we know if the state is not set. */
export function suburbsFor(state: string): string[] {
  return SUBURBS[state] ?? Object.values(SUBURBS).flat();
}

/** Match a name we scraped against the real list, so casing stays tidy. */
export function canonicalSuburb(name: string, state: string): string | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  return suburbsFor(state).find((s) => s.toLowerCase() === want) ?? null;
}
