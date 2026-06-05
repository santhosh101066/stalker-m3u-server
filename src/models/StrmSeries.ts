import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Index,
  Default,
} from "sequelize-typescript";

@Table({ tableName: "strm_series", timestamps: true })
export class StrmSeries extends Model {
  @PrimaryKey
  @Column(DataType.STRING)
  id!: string; // "seriesep_{ep_id}"

  @Index
  @Column(DataType.STRING)
  canonical_key!: string; // normalised show name — used to group duplicate shows

  @Column(DataType.STRING)
  raw_folder!: string; // episode's own show folder name, never overwritten by merge

  @Default(0)
  @Column(DataType.INTEGER)
  variant_tags!: number; // count of show-level variant tags — 0 = cleanest primary

  @Column(DataType.STRING)
  folder_path!: string; // "ShowName/Season XX" — updated by Phase 2 for duplicate shows

  @Column(DataType.STRING)
  file_name!: string; // episode filename — updated by Phase 2 for duplicate shows

  @Column(DataType.STRING)
  url!: string; // stream URL written inside the .strm file

  @Default(false)
  @Column(DataType.BOOLEAN)
  synced_to_disk!: boolean; // true once the .strm file has been successfully written
}
