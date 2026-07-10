import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Index,
  Default,
} from "sequelize-typescript";

@Table({ tableName: "strm_movies", timestamps: true })
export class StrmMovie extends Model {
  @PrimaryKey
  @Column(DataType.STRING)
  id!: string; // "movie_{stream_id}"

  @Index
  @Column(DataType.STRING)
  canonical_key!: string; // normalised title — used to group duplicates

  @Column(DataType.STRING)
  raw_folder!: string; // entry's own original folder name, never overwritten by merge

  @Default(0)
  @Column(DataType.INTEGER)
  variant_tags!: number; // count of variant tags — 0 = cleanest, becomes primary

  @Column(DataType.STRING)
  folder_path!: string; // merged folder relative from outputDir — updated by Phase 2

  @Column(DataType.STRING)
  file_name!: string; // filename within folder — updated by Phase 2 for secondaries

  @Column(DataType.STRING)
  url!: string; // stream URL written inside the .strm file

  @Default(false)
  @Column(DataType.BOOLEAN)
  synced_to_disk!: boolean; // true once the .strm file has been successfully written
}
